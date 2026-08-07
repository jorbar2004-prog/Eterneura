// Cloudflare Pages Function — /api/chat
// v4.8: soporte de streaming (SSE) + fix de contenido vacío en visión

const GROQ_MODELS = [
  'moonshotai/kimi-k2-instruct-0905',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b'
];

const OPENROUTER_MODELS = [
  'moonshotai/kimi-k2.6:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'poolside/laguna-m.1:free',
  'cohere/north-mini-code:free'
];

// Modelos gratuitos con soporte de visión confirmado en OpenRouter (ago. 2026).
// 'openrouter/free' queda último: es el auto-router de OpenRouter, elige el
// modelo gratuito que mejor matchea el pedido (incluida visión) — buen último recurso.
const OPENROUTER_VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'openrouter/free'
];

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Busca información actual en internet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'La consulta de búsqueda.' }
      },
      required: ['query']
    }
  }
};

// Nombres cortos y amigables para mostrar como estado en el chat mientras se prueban modelos.
function friendlyModelName(model) {
  const map = {
    'moonshotai/kimi-k2-instruct-0905': 'Kimi K2',
    'openai/gpt-oss-120b': 'GPT-OSS 120B',
    'openai/gpt-oss-20b': 'GPT-OSS 20B',
    'qwen/qwen3.6-27b': 'Qwen 3.6',
    'moonshotai/kimi-k2.6:free': 'Kimi K2.6',
    'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3',
    'google/gemma-4-31b-it:free': 'Gemma 4',
    'qwen/qwen3-next-80b-a3b-instruct:free': 'Qwen 3 Next',
    'openai/gpt-oss-20b:free': 'GPT-OSS 20B',
    'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron 3 Super',
    'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra',
    'poolside/laguna-m.1:free': 'Laguna M.1',
    'cohere/north-mini-code:free': 'North Mini',
    'nvidia/nemotron-nano-12b-v2-vl:free': 'Nemotron Nano VL',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 'Nemotron Omni',
    'openrouter/free': 'router automático'
  };
  return map[model] || model.split('/').pop().replace(':free', '');
}

async function serperSearch(apiKey, query) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 6 })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.organic || []).map(r => ({
      title: r.title || '', url: r.link || '', description: r.snippet || ''
    }));
  } catch (e) {
    console.error('Serper error:', e);
    return [];
  }
}

function formatSearchResults(results, query) {
  if (!results.length) return `No se encontraron resultados para: "${query}".`;
  return `Resultados de búsqueda web para "${query}":\n\n` +
    results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   Fuente: ${r.url}`).join('\n\n');
}

async function callGroq(apiKey, model, messages, tools) {
  const body = { model, messages, max_tokens: 2200, temperature: 0.7 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function callOpenRouter(apiKey, model, messages, tools) {
  const body = { model, messages, max_tokens: 2200, temperature: 0.7 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eterneura.pages.dev', 'X-Title': 'Eterneura'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function callWithSearch(callFn, messages, serperKey) {
  const tools = serperKey ? [WEB_SEARCH_TOOL] : [];
  const result = await callFn(messages, tools);
  if (!result.ok) return result;

  const choice = result.data.choices?.[0];
  if (choice?.finish_reason === 'tool_calls' && serperKey) {
    const toolCalls = choice.message?.tool_calls || [];
    const assistantMsg = choice.message;

    const toolResults = await Promise.all(
      toolCalls.map(async tc => {
        let query = '';
        try { query = JSON.parse(tc.function.arguments).query || ''; } catch {}
        const results = query ? await serperSearch(serperKey, query) : [];
        return { role: 'tool', tool_call_id: tc.id, name: 'web_search', content: formatSearchResults(results, query) };
      })
    );

    const msgs2 = [...messages, assistantMsg, ...toolResults];
    return await callFn(msgs2, []);
  }
  return result;
}

// Extraer texto OCR del mensaje si existe
function extractOCRFromMessages(messages) {
  for (const msg of messages) {
    if (typeof msg.content === 'string' && msg.content.includes('--- TEXTO EXTRAÍDO VIA OCR ---')) {
      const match = msg.content.match(/--- TEXTO EXTRAÍDO VIA OCR ---([\s\S]*?)--- FIN OCR ---/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

// Preparar mensajes para fallback a texto (quitar imágenes, mantener OCR)
function prepareTextFallback(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ...msg, content: textParts };
    }
    return msg;
  });
}

// Extrae el texto de respuesta de un choice, o null si viene vacío/en blanco.
// IMPORTANTE: un 200 OK con content vacío NO es una respuesta válida — varios
// modelos gratuitos de visión devuelven ok:true con content "" cuando no
// pudieron procesar la imagen, y antes eso se mostraba como "Sin respuesta."
function extractContent(result) {
  const content = result?.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed.length ? trimmed : null;
}

// ────────────────────────────────────────────────────────────
// Generadores async: cada uno yieldea eventos {type:'status',message}
// y termina yieldeando {type:'done',reply} o {type:'error',error}.
// Un mismo generador sirve tanto para la respuesta streaming (SSE)
// como para la respuesta JSON clásica (se consume hasta el 'done').
// ────────────────────────────────────────────────────────────

async function* runVisionFlow({ orKey, groqKey, messages, serperKey }) {
  const ocrText = extractOCRFromMessages(messages);
  let lastError = null;

  if (orKey) {
    for (const model of OPENROUTER_VISION_MODELS) {
      yield { type: 'status', message: `Analizando la imagen con ${friendlyModelName(model)}…` };
      let result;
      try { result = await callOpenRouter(orKey, model, messages, []); }
      catch (err) { lastError = err.message; continue; }

      if (result.ok) {
        const content = extractContent(result);
        if (content) { yield { type: 'done', reply: content }; return; }
        // 200 OK pero sin contenido real: no es un éxito, seguimos probando.
        lastError = `${model}: respuesta vacía`;
        console.warn(`Visión (${model}) devolvió contenido vacío — se descarta y se sigue probando.`);
        continue;
      }
      lastError = result.data.error?.message || `OR ${result.status} (${model})`;
      console.warn(`Visión falló (${model}):`, lastError);
      // Para errores duros (no 429/404) igual seguimos probando el próximo
      // modelo de visión — a diferencia del flujo de texto, acá preferimos
      // agotar toda la lista antes de rendirnos, porque son pocos modelos.
    }
  }

  // Fallback a texto usando OCR si el frontend lo mandó
  if (ocrText) {
    yield { type: 'status', message: 'No se pudo leer la imagen — usando el texto extraído por OCR…' };
    const textMessages = prepareTextFallback(messages);
    const lastMsg = textMessages[textMessages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = `[NOTA: No pude analizar la imagen directamente, pero extraje el siguiente texto via OCR:]\n\n${ocrText}\n\n[Pregunta del usuario:]\n${lastMsg.content}`;
    }

    if (groqKey) {
      for (const model of GROQ_MODELS) {
        yield { type: 'status', message: `Interpretando el OCR con ${friendlyModelName(model)}…` };
        let result;
        try { result = await callWithSearch((msgs, tools) => callGroq(groqKey, model, msgs, tools), textMessages, serperKey); }
        catch (err) { lastError = 'Groq: ' + err.message; continue; }
        if (result.ok) {
          const content = extractContent(result);
          if (content) { yield { type: 'done', reply: content }; return; }
          lastError = `${model}: respuesta vacía`;
          continue;
        }
        lastError = result.data.error?.message || `Groq ${result.status}`;
        if (result.status !== 429 && result.status !== 404) break;
      }
    }

    if (orKey) {
      for (const model of OPENROUTER_MODELS) {
        yield { type: 'status', message: `Interpretando el OCR con ${friendlyModelName(model)}…` };
        let result;
        try { result = await callWithSearch((msgs, tools) => callOpenRouter(orKey, model, msgs, tools), textMessages, serperKey); }
        catch (err) { lastError = 'OR: ' + err.message; continue; }
        if (result.ok) {
          const content = extractContent(result);
          if (content) { yield { type: 'done', reply: content }; return; }
          lastError = `${model}: respuesta vacía`;
          continue;
        }
        lastError = result.data.error?.message || `OR ${result.status}`;
        if (result.status !== 429 && result.status !== 404) break;
      }
    }
  }

  // Último recurso: mensaje útil al usuario (no un error crudo)
  console.warn('Vision flow agotado. lastError:', lastError);
  yield {
    type: 'done',
    reply: ocrText
      ? `No pude analizar la imagen directamente (los modelos de visión están saturados), pero extraje este texto via OCR:\n\n---\n${ocrText}\n---\n\n¿Querés que verifique este contenido?`
      : 'No pude analizar la imagen directamente — los modelos de visión gratuitos están saturados o no devolvieron una respuesta válida en este momento. Si la imagen contiene texto, podés copiarlo y pegarlo acá, o describirme qué ves y seguimos desde ahí.'
  };
}

async function* runTextFlow({ groqKey, orKey, messages, serperKey }) {
  let lastError = null;

  if (groqKey) {
    for (const model of GROQ_MODELS) {
      yield { type: 'status', message: `Pensando con ${friendlyModelName(model)}…` };
      let result;
      try { result = await callWithSearch((msgs, tools) => callGroq(groqKey, model, msgs, tools), messages, serperKey); }
      catch (err) { lastError = 'Groq: ' + err.message; continue; }
      if (result.ok) {
        const content = extractContent(result);
        if (content) { yield { type: 'done', reply: content }; return; }
        lastError = `${model}: respuesta vacía`;
        console.warn(`Groq (${model}) devolvió contenido vacío — se sigue probando.`);
        continue;
      }
      lastError = result.data.error?.message || `Groq ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      yield { type: 'status', message: `Cambiando a ${friendlyModelName(model)}…` };
      let result;
      try { result = await callWithSearch((msgs, tools) => callOpenRouter(orKey, model, msgs, tools), messages, serperKey); }
      catch (err) { lastError = 'OR: ' + err.message; continue; }
      if (result.ok) {
        const content = extractContent(result);
        if (content) { yield { type: 'done', reply: content }; return; }
        lastError = `${model}: respuesta vacía`;
        console.warn(`OpenRouter (${model}) devolvió contenido vacío — se sigue probando.`);
        continue;
      }
      lastError = result.data.error?.message || `OR ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  yield { type: 'error', error: 'Todos los motores están saturados. (' + lastError + ')' };
}

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  const groqKey  = context.env.GROQ_API_KEY;
  const orKey    = context.env.OPENROUTER_API_KEY;
  const serperKey = context.env.SERPER_API_KEY;

  if (!groqKey && !orKey) {
    return jsonRes(500, { error: 'No hay ninguna API key configurada.' });
  }

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { messages, hasImages, stream } = body;
  if (!messages?.length) return jsonRes(400, { error: 'Falta messages' });

  const gen = hasImages
    ? runVisionFlow({ orKey, groqKey, messages, serperKey })
    : runTextFlow({ groqKey, orKey, messages, serperKey });

  // ── Modo streaming (SSE) — lo que usa el chat principal ──
  if (stream === true) {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        try {
          for await (const ev of gen) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
        } catch (err) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n\n`));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        ...cors
      }
    });
  }

  // ── Modo clásico (JSON completo) — usado por resumen de sesión,
  //    evaluador académico, análisis de clima, etc. ──
  let final = null;
  try {
    for await (const ev of gen) {
      if (ev.type === 'done')  { final = { reply: ev.reply }; break; }
      if (ev.type === 'error') { final = { error: ev.error }; break; }
    }
  } catch (err) {
    final = { error: err.message || String(err) };
  }
  if (!final) final = { error: 'Sin respuesta del servidor.' };
  return jsonRes(final.error ? 502 : 200, final);
}

export async function onRequestOptions() {
  return new Response('', {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}
