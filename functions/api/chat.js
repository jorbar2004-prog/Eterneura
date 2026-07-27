// Cloudflare Pages Function — /api/chat
// v4.7.2-hotfix: fallback automático visión→texto, OCR support, mejor manejo de errores

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
function prepareTextFallback(messages, ocrText) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      // Filtrar solo los bloques de texto, quitar imágenes
      const textParts = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ...msg, content: textParts };
    }
    return msg;
  });
}

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  const groqKey = context.env.GROQ_API_KEY;
  const orKey = context.env.OPENROUTER_API_KEY;
  const serperKey = context.env.SERPER_API_KEY;

  if (!groqKey && !orKey) {
    return jsonRes(500, { error: 'No hay ninguna API key configurada.' });
  }

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { messages, hasImages } = body;
  if (!messages?.length) return jsonRes(400, { error: 'Falta messages' });

  const ocrText = extractOCRFromMessages(messages);
  let lastError = null;

  // ============================================================
  // MODO IMÁGENES: intentar visión primero, fallback a texto
  // ============================================================
  if (hasImages) {
    // 1. Intentar modelos de visión
    if (orKey) {
      for (const model of OPENROUTER_VISION_MODELS) {
        let result;
        try { result = await callOpenRouter(orKey, model, messages, []); }
        catch (err) { lastError = err.message; continue; }
        if (result.ok) {
          const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
          return jsonRes(200, { reply });
        }
        lastError = result.data.error?.message || `OR ${result.status}`;
        console.warn(`Visión falló (${model}):`, lastError);
        if (result.status !== 429 && result.status !== 404) break;
      }
    }

    // 2. Fallback: si hay OCR, usar modelo de texto con el OCR como contexto
    if (ocrText) {
      console.log('Fallback a texto con OCR');
      const textMessages = prepareTextFallback(messages, ocrText);

      // Agregar contexto OCR al system prompt o al último mensaje
      const lastMsg = textMessages[textMessages.length - 1];
      if (lastMsg.role === 'user') {
        lastMsg.content = `[NOTA: No pude analizar la imagen directamente, pero extraje el siguiente texto via OCR:]\n\n${ocrText}\n\n[Pregunta del usuario:]\n${lastMsg.content}`;
      }

      // Intentar con modelos de texto
      if (groqKey) {
        for (const model of GROQ_MODELS) {
          let result;
          try { result = await callWithSearch((msgs, tools) => callGroq(groqKey, model, msgs, tools), textMessages, serperKey); }
          catch (err) { lastError = 'Groq: ' + err.message; continue; }
          if (result.ok) {
            const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
            return jsonRes(200, { reply });
          }
          lastError = result.data.error?.message || `Groq ${result.status}`;
          if (result.status !== 429 && result.status !== 404) break;
        }
      }

      if (orKey) {
        for (const model of OPENROUTER_MODELS) {
          let result;
          try { result = await callWithSearch((msgs, tools) => callOpenRouter(orKey, model, msgs, tools), textMessages, serperKey); }
          catch (err) { lastError = 'OR: ' + err.message; continue; }
          if (result.ok) {
            const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
            return jsonRes(200, { reply });
          }
          lastError = result.data.error?.message || `OR ${result.status}`;
          if (result.status !== 429 && result.status !== 404) break;
        }
      }
    }

    // 3. Último recurso: mensaje útil al usuario
    return jsonRes(200, {
      reply: ocrText
        ? `No pude analizar la imagen directamente (los modelos de visión están saturados), pero extraje este texto via OCR:\n\n---\n${ocrText}\n---\n\n¿Querés que verifique este contenido?`
        : 'No pude analizar la imagen directamente (los modelos de visión están saturados). Si la imagen contiene texto, podés copiarlo y pegarlo acá, o describirme qué ves y hago la verificación.'
    });
  }

  // ============================================================
  // MODO TEXTO NORMAL
  // ============================================================
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try { result = await callWithSearch((msgs, tools) => callGroq(groqKey, model, msgs, tools), messages, serperKey); }
      catch (err) { lastError = 'Groq: ' + err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return jsonRes(200, { reply });
      }
      lastError = result.data.error?.message || `Groq ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      let result;
      try { result = await callWithSearch((msgs, tools) => callOpenRouter(orKey, model, msgs, tools), messages, serperKey); }
      catch (err) { lastError = 'OR: ' + err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return jsonRes(200, { reply });
      }
      lastError = result.data.error?.message || `OR ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  return jsonRes(429, { error: 'Todos los motores están saturados. (' + lastError + ')' });
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
