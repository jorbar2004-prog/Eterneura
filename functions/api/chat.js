// Cloudflare Pages Function — runtime: Workers (V8 isolate, no Node.js)
// Responde en /api/chat. Misma lógica de fallback que la versión de Netlify.

const FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-4-maverick:free',
  'google/gemini-flash-1.5:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free'
];

async function callOpenRouter(apiKey, model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eterneura.pages.dev',
      'X-Title': 'Eternaura'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OPENROUTER_API_KEY no configurada en las variables de entorno de Cloudflare Pages.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { messages, model } = body;
  if (!messages?.length) {
    return new Response(JSON.stringify({ error: 'Falta messages' }), { status: 400 });
  }

  const tryOrder = model
    ? [model, ...FALLBACK_MODELS.filter(m => m !== model)]
    : FALLBACK_MODELS;

  let lastError = null;

  for (const candidate of tryOrder) {
    let result;
    try {
      result = await callOpenRouter(apiKey, candidate, messages);
    } catch (err) {
      lastError = 'No se pudo conectar con OpenRouter: ' + err.message;
      continue;
    }

    if (result.ok) {
      const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
      return new Response(
        JSON.stringify({ reply, modelUsed: candidate }),
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    lastError = result.data.error?.message || `Error ${result.status} del modelo ${candidate}`;
    if (result.status !== 429 && result.status !== 404) {
      return new Response(
        JSON.stringify({ error: lastError }),
        { status: result.status, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(
    JSON.stringify({
      error: 'Todos los modelos gratuitos están saturados en este momento. Probá de nuevo en unos minutos. (' + lastError + ')'
    }),
    { status: 429, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

