// Cloudflare Pages Function — /api/chat
// v5.1.0: motor unificado + SSE status streaming + empty-content fix

const GROQ_MODELS = [
  'moonshotai/kimi-k2-instruct-0905',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b'
];

const OPENROUTER_MODELS = [
  'moonshotai/kimi-k2.6:free',
  'google/gemma-4-31b-it:free',
  'inclusionai/ling-3.0-flash:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-nano-9b-v2:free'
];

const OPENROUTER_VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'moonshotai/kimi-vl-a3b-thinking:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-4-scout:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'qwen/qwen2.5-vl-3b-instruct:free',
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

// =============================================================================
// UTILIDADES
// =============================================================================

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function getValidReply(result) {
  const content = result.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (/^(null|undefined|none|nil)$/i.test(trimmed)) return null;
  return trimmed;
}

// =============================================================================
// SERPER
// =============================================================================

async function serperSearch(apiKey, query) {
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 6 })
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (data.organic || []).map(r => ({
      title: r.title || '', url: r.link || '', description: r.snippet || ''
    }));
  } catch (e) {
    console.error('Serper error:', e.message);
    return [];
  }
}

function formatSearchResults(results, query) {
  if (!results.length) return `No se encontraron resultados para: "${query}".`;
  return `Resultados de búsqueda web para "${query}":\n\n` +
    results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   Fuente: ${r.url}`).join('\n\n');
}

// =============================================================================
// PROVIDERS
// =============================================================================

async function callGroq(apiKey, model, messages, tools) {
  const body = { model, messages, max_tokens: 2200, temperature: 0.7 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  try {
    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, status: 408, data: { error: { message: 'Groq timeout' } } };
    }
    return { ok: false, status: 0, data: { error: { message: e.message } } };
  }
}

async function callOpenRouter(apiKey, model, messages, tools) {
  const body = { model, messages, max_tokens: 2200, temperature: 0.7 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://eterneura.pages.dev',
        'X-Title': 'Eterneura'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, status: 408, data: { error: { message: 'OpenRouter timeout' } } };
    }
    return { ok: false, status: 0, data: { error: { message: e.message } } };
  }
}

async function callWithSearch(callFn, messages, serperKey, reporter) {
  const tools = serperKey ? [WEB_SEARCH_TOOL] : [];
  const result = await callFn(messages, tools);
  if (!result.ok) return result;

  const choice = result.data?.choices?.[0];
  if (choice?.finish_reason === 'tool_calls' && serperKey) {
    const toolCalls = choice.message?.tool_calls || [];
    const assistantMsg = choice.message;

    reporter?.status('Buscando en la web...');

    const toolResults = await Promise.all(
      toolCalls.map(async tc => {
        let query = '';
        try { query = JSON.parse(tc.function.arguments).query || ''; } catch {}
        const results = query ? await serperSearch(serperKey, query) : [];
        return {
          role: 'tool',
          tool_call_id: tc.id,
          name: 'web_search',
          content: formatSearchResults(results, query)
        };
      })
    );

    reporter?.status('Analizando resultados...');

    const msgs2 = [...messages, assistantMsg, ...toolResults];
    return await callFn(msgs2, []);
  }
  return result;
}

// =============================================================================
// OCR
// =============================================================================

function extractOCRFromMessages(messages) {
  for (const msg of messages) {
    if (typeof msg.content === 'string' && msg.content.includes('--- TEXTO EXTRAÍDO VIA OCR ---')) {
      const match = msg.content.match(/--- TEXTO EXTRAÍDO VIA OCR ---([\s\S]*?)--- FIN OCR ---/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

function prepareTextFallback(messages, ocrText) {
  const out = messages.map(msg => {
    if (typeof msg.content === 'string') return { ...msg };
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ...msg, content: textParts };
    }
    return { ...msg };
  });

  const lastMsg = out[out.length - 1];
  if (lastMsg?.role === 'user') {
    lastMsg.content = `[NOTA: No pude analizar la imagen directamente, pero extraje el siguiente texto via OCR:]\n\n${ocrText}\n\n[Pregunta del usuario:]\n${lastMsg.content}`;
  }
  return out;
}

// =============================================================================
// MOTOR DE FALLBACK
// =============================================================================

async function trySequential(models, caller, reporter) {
  const attempts = [];
  for (const model of models) {
    const shortName = model.split('/').pop();
    reporter?.status(`Consultando ${shortName}...`);
    try {
      const result = await caller(model);
      if (result.ok) {
        const reply = getValidReply(result);
        if (reply) {
          reporter?.status('Generando respuesta...');
          return { success: true, reply, model, attempts };
        }
        attempts.push({ model, status: 'empty' });
        reporter?.status('Respuesta vacía, probando alternativa...');
        continue;
      }
      const err = result.data?.error?.message || `HTTP ${result.status}`;
      attempts.push({ model, status: 'error', error: err, code: result.status });
      if (result.status !== 429 && result.status !== 404) {
        reporter?.status('Error de conexión, probando respaldo...');
        break;
      }
      reporter?.status('Saturado, probando alternativa...');
    } catch (e) {
      attempts.push({ model, status: 'exception', error: e.message });
      reporter?.status('Error de conexión, probando respaldo...');
    }
  }
  return { success: false, attempts };
}

async function tryParallelThenSequential(models, caller, parallelCount = 3, reporter) {
  const batch = models.slice(0, parallelCount);
  const rest = models.slice(parallelCount);
  const attempts = [];

  reporter?.status('Consultando modelos de visión...');

  const settled = await Promise.allSettled(
    batch.map(async (model) => {
      const r = await caller(model);
      return { model, ...r };
    })
  );

  for (const s of settled) {
    if (s.status === 'rejected') {
      attempts.push({ model: s.reason?.model || 'unknown', status: 'exception', error: s.reason.message });
      continue;
    }
    const { model, ok, data, status: httpStatus } = s.value;
    if (ok) {
      const reply = getValidReply({ data });
      if (reply) {
        reporter?.status('Generando respuesta...');
        return { success: true, reply, model, attempts };
      }
      attempts.push({ model, status: 'empty' });
    } else {
      const err = data?.error?.message || `HTTP ${httpStatus}`;
      attempts.push({ model, status: 'error', error: err, code: httpStatus });
    }
  }

  const hadFatal = attempts.some(a => a.code && a.code !== 429 && a.code !== 404);
  if (rest.length && !hadFatal) {
    reporter?.status('Probando modelos adicionales...');
    const seq = await trySequential(rest, caller, reporter);
    return { ...seq, attempts: [...attempts, ...seq.attempts] };
  }

  return { success: false, attempts };
}

// =============================================================================
// CORE LOGIC
// =============================================================================

async function handleChat(messages, hasImages, env, reporter) {
  const groqKey = env.GROQ_API_KEY;
  const orKey = env.OPENROUTER_API_KEY;
  const serperKey = env.SERPER_API_KEY;
  let lastError = null;
  const allAttempts = [];

  reporter?.status('Analizando tu consulta...');

  // ============================================================
  // MODO IMÁGENES
  // ============================================================
  if (hasImages) {
    reporter?.status('Analizando imagen...');
    const ocrText = extractOCRFromMessages(messages);

    // 1. Visión: race paralelo de los primeros 3, luego secuencial
    if (orKey) {
      const visionRes = await tryParallelThenSequential(
        OPENROUTER_VISION_MODELS,
        (model) => callOpenRouter(orKey, model, messages, []),
        3,
        reporter
      );
      if (visionRes.success) return { reply: visionRes.reply, model: visionRes.model };
      allAttempts.push(...visionRes.attempts);
    }

    // 2. Fallback OCR → texto
    if (ocrText) {
      reporter?.status('Extrayendo texto de la imagen...');
      const textMessages = prepareTextFallback(messages, ocrText);

      if (groqKey) {
        const groqRes = await trySequential(GROQ_MODELS, (model) =>
          callWithSearch(
            (msgs, tools) => callGroq(groqKey, model, msgs, tools),
            textMessages,
            serperKey,
            reporter
          ),
          reporter
        );
        if (groqRes.success) return { reply: groqRes.reply, model: groqRes.model };
        allAttempts.push(...groqRes.attempts);
      }

      if (orKey) {
        const orRes = await trySequential(OPENROUTER_MODELS, (model) =>
          callWithSearch(
            (msgs, tools) => callOpenRouter(orKey, model, msgs, tools),
            textMessages,
            serperKey,
            reporter
          ),
          reporter
        );
        if (orRes.success) return { reply: orRes.reply, model: orRes.model };
        allAttempts.push(...orRes.attempts);
      }
    }

    // 3. Último recurso
    reporter?.status('Preparando respuesta alternativa...');
    const fallbackReply = ocrText
      ? `No pude analizar la imagen directamente (los modelos de visión están saturados), pero extraje este texto via OCR:\n\n---\n${ocrText}\n---\n\n¿Querés que verifique este contenido?`
      : 'No pude analizar la imagen directamente (los modelos de visión están saturados). Si la imagen contiene texto, podés copiarlo y pegarlo acá, o describirme qué ves y hago la verificación.';
    return { reply: fallbackReply, model: null };
  }

  // ============================================================
  // MODO TEXTO NORMAL
  // ============================================================
  reporter?.status('Pensando...');

  if (groqKey) {
    const groqRes = await trySequential(GROQ_MODELS, (model) =>
      callWithSearch(
        (msgs, tools) => callGroq(groqKey, model, msgs, tools),
        messages,
        serperKey,
        reporter
      ),
      reporter
    );
    if (groqRes.success) return { reply: groqRes.reply, model: groqRes.model };
    allAttempts.push(...groqRes.attempts);
  }

  if (orKey) {
    const orRes = await trySequential(OPENROUTER_MODELS, (model) =>
      callWithSearch(
        (msgs, tools) => callOpenRouter(orKey, model, msgs, tools),
        messages,
        serperKey,
        reporter
      ),
      reporter
    );
    if (orRes.success) return { reply: orRes.reply, model: orRes.model };
    allAttempts.push(...orRes.attempts);
  }

  const lastErrorMsg = allAttempts.at(-1)?.error || 'Sin detalles';
  return { error: `Todos los motores están saturados. (${lastErrorMsg})` };
}

// =============================================================================
// HANDLER PRINCIPAL
// =============================================================================

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors }
    });

  const groqKey = context.env.GROQ_API_KEY;
  const orKey = context.env.OPENROUTER_API_KEY;
  const serperKey = context.env.SERPER_API_KEY;

  if (!groqKey && !orKey) {
    return jsonRes(500, { error: 'No hay ninguna API key configurada.' });
  }

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { messages, hasImages, stream } = body;
  if (!messages?.length) return jsonRes(400, { error: 'Falta messages' });

  // ── Modo Streaming (SSE) ─────────────────────────────────
  if (stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const reporter = {
      status: (msg) => {
        try {
          writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'status', message: msg })}\n\n`));
        } catch(_) {}
      },
      done: (reply, model) => {
        try {
          writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'done', reply, model })}\n\n`));
        } catch(_) {}
        writer.close();
      },
      error: (err) => {
        try {
          writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err })}\n\n`));
        } catch(_) {}
        writer.close();
      }
    };

    handleChat(messages, hasImages, context.env, reporter)
      .then(result => {
        if (result.error) reporter.error(result.error);
        else reporter.done(result.reply, result.model);
      })
      .catch(err => reporter.error(err.message));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...cors
      }
    });
  }

  // ── Modo JSON clásico (Evaluador, Clima, etc.) ──────────
  try {
    const result = await handleChat(messages, hasImages, context.env, null);
    if (result.error) return jsonRes(429, { error: result.error });
    return jsonRes(200, { reply: result.reply });
  } catch (err) {
    return jsonRes(500, { error: err.message });
  }
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
