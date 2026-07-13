// Cloudflare Pages Function — /api/chat
// Igual que la versión Netlify pero usando la API de Cloudflare Workers.

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

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Busca información actual en internet. Usá esta tool cuando necesites datos recientes, noticias, hechos que puedan haber cambiado, o cualquier cosa que no tengas seguridad de conocer con certeza.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'La consulta de búsqueda en el idioma más apropiado.'
        }
      },
      required: ['query']
    }
  }
};

async function braveSearch(apiKey, query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6&search_lang=es&ui_lang=es-AR&country=AR`;
  const res  = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.web?.results || []).map(r => ({
    title: r.title || '', url: r.url || '', description: r.description || ''
  }));
}

function formatSearchResults(results, query) {
  if (!results.length) return `No se encontraron resultados para: "${query}".`;
  return `Resultados de búsqueda web para "${query}":\n\n` +
    results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   Fuente: ${r.url}`).join('\n\n');
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
      'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eterneura.pages.dev', 'X-Title': 'Eterneura'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function callWithSearch(callFn, messages, braveKey) {
  const tools  = braveKey ? [WEB_SEARCH_TOOL] : [];
  const result = await callFn(messages, tools);
  if (!result.ok) return result;

  const choice = result.data.choices?.[0];
  if (choice?.finish_reason === 'tool_calls' && braveKey) {
    const toolCalls    = choice.message?.tool_calls || [];
    const assistantMsg = choice.message;

    const toolResults = await Promise.all(
      toolCalls.map(async tc => {
        let query = '';
        try { query = JSON.parse(tc.function.arguments).query || ''; } catch {}
        const results = query ? await braveSearch(braveKey, query) : [];
        return { role: 'tool', tool_call_id: tc.id, name: 'web_search', content: formatSearchResults(results, query) };
      })
    );

    const msgs2   = [...messages, assistantMsg, ...toolResults];
    const result2 = await callFn(msgs2, []);
    return result2;
  }
  return result;
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
  const braveKey = context.env.BRAVE_API_KEY;

  if (!groqKey && !orKey) return jsonRes(500, { error: 'No hay ninguna API key configurada.' });

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { messages, hasImages } = body;
  if (!messages?.length) return jsonRes(400, { error: 'Falta messages' });

  if (hasImages && !orKey) return jsonRes(500, { error: 'El análisis de imágenes requiere OPENROUTER_API_KEY.' });

  let lastError = null;

  if (hasImages) {
    for (const model of OPENROUTER_VISION_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages, []); }
      catch (err) { lastError = err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return jsonRes(200, { reply });
      }
      lastError = result.data.error?.message || `OR ${result.status}`;
      if (result.status !== 429 && result.status !== 404) break;
    }
    return jsonRes(429, { error: 'Modelos de visión saturados. (' + lastError + ')' });
  }

  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try { result = await callWithSearch((msgs, tools) => callGroq(groqKey, model, msgs, tools), messages, braveKey); }
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
      try { result = await callWithSearch((msgs, tools) => callOpenRouter(orKey, model, msgs, tools), messages, braveKey); }
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
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
  });
}
