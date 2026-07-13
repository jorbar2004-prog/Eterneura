// Netlify Function — /api/chat
//
// ── Motores de IA ──
// Texto:    1) Groq (llama-3.3-70b-versatile, etc.)   2) OpenRouter (respaldo)
// Visión:   OpenRouter (modelos gratuitos con visión)
// Búsqueda: Brave Search API (SERPER_API_KEY) — se activa automáticamente cuando
//           el modelo necesita información actual. El backend orquesta el ciclo
//           tool-use → búsqueda → segunda llamada al modelo con resultados.

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama3-70b-8192',
  'mixtral-8x7b-32768'
];

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-4-maverick:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free'
];

const OPENROUTER_VISION_MODELS = [
  'qwen/qwen2.5-vl-72b-instruct:free',
  'qwen/qwen2.5-vl-32b-instruct:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'google/gemma-3-27b-it:free'
];

// Definición de la tool de búsqueda web (formato OpenAI tool_use)
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Busca información actual en internet. Usá esta tool cuando necesites datos recientes, noticias, hechos que puedan haber cambiado, o cualquier cosa que no tengas seguridad de conocer con certeza. Devuelve los títulos, URLs y descripciones de los resultados más relevantes.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'La consulta de búsqueda en el idioma más apropiado (español para temas locales/argentinos, inglés para temas técnicos o internacionales).'
        }
      },
      required: ['query']
    }
  }
};

async function serperSearch(apiKey, query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 6 })
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.organic || []).map(r => ({
    title:       r.title   || '',
    url:         r.link    || '',
    description: r.snippet || ''
  }));
}

function formatSearchResults(results, query) {
  if (!results.length) return `No se encontraron resultados para: "${query}".`;
  return `Resultados de búsqueda web para "${query}":\n\n` +
    results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.description}\n   Fuente: ${r.url}`
    ).join('\n\n');
}

async function callGroq(apiKey, model, messages, tools) {
  const body = { model, messages, max_tokens: 2200, temperature: 0.7 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res  = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  const res  = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eterneura.netlify.app',
      'X-Title': 'Eterneura'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Llama al modelo y si pide web_search, ejecuta la búsqueda y hace una segunda
// llamada con los resultados. Máximo 2 rondas de tool-use para no exceder latencia.
async function callWithSearch(callFn, messages, braveKey) {
  const tools    = braveKey ? [WEB_SEARCH_TOOL] : [];
  const result   = await callFn(messages, tools);
  if (!result.ok) return result;

  const choice   = result.data.choices?.[0];
  const finish   = choice?.finish_reason;

  // Si el modelo pidió usar la tool de búsqueda
  if (finish === 'tool_calls' && braveKey) {
    const toolCalls = choice.message?.tool_calls || [];
    const assistantMsg = choice.message;

    // Ejecutar todas las búsquedas pedidas (normalmente 1)
    const toolResults = await Promise.all(
      toolCalls.map(async tc => {
        let query = '';
        try { query = JSON.parse(tc.function.arguments).query || ''; } catch {}
        const results = query ? await serperSearch(braveKey, query) : [];
        return {
          role: 'tool',
          tool_call_id: tc.id,
          name: 'web_search',
          content: formatSearchResults(results, query)
        };
      })
    );

    // Segunda llamada: modelo + historial + resultado de la búsqueda
    const msgs2   = [...messages, assistantMsg, ...toolResults];
    const result2 = await callFn(msgs2, []); // sin tools para evitar bucle
    return result2;
  }

  return result;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, body: 'Method Not Allowed' };

  const groqKey  = process.env.GROQ_API_KEY;
  const orKey    = process.env.OPENROUTER_API_KEY;
  const braveKey = process.env.SERPER_API_KEY;

  if (!groqKey && !orKey) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'No hay ninguna API key configurada.' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { messages, hasImages } = body;
  if (!messages?.length) return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'Falta messages' })
  };

  if (hasImages && !orKey) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'El análisis de imágenes requiere OPENROUTER_API_KEY.' })
  };

  let lastError = null;

  // ── Visión: directo a OpenRouter ──
  if (hasImages) {
    for (const model of OPENROUTER_VISION_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages, []); }
      catch (err) { lastError = err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ reply }) };
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status}`;
      if (result.status !== 429 && result.status !== 404) break;
    }
    return { statusCode: 429, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Modelos de visión saturados. Intentá de nuevo. (' + lastError + ')' }) };
  }

  // ── Texto: Groq primero (con web search si hay SERPER_API_KEY) ──
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try {
        result = await callWithSearch(
          (msgs, tools) => callGroq(groqKey, model, msgs, tools),
          messages,
          braveKey
        );
      } catch (err) { lastError = 'Groq: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ reply }) };
      }
      lastError = result.data.error?.message || `Groq ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  // ── Texto: OpenRouter como respaldo ──
  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      let result;
      try {
        result = await callWithSearch(
          (msgs, tools) => callOpenRouter(orKey, model, msgs, tools),
          messages,
          braveKey
        );
      } catch (err) { lastError = 'OpenRouter: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ reply }) };
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  return {
    statusCode: 429,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'Todos los motores gratuitos están saturados. Intentá en unos minutos. (' + lastError + ')' })
  };
};
