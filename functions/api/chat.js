// Cloudflare Pages Function — runtime: Workers (V8 isolate, no Node.js)
// Responde en /api/chat.
//
// ── Motores de IA, en orden de preferencia ──
// 1) Groq: gratis, sin tarjeta, ~14.400 mensajes/día. Motor principal.
// 2) OpenRouter: respaldo si Groq también falla o no está configurado.

const GROQ_MODELS = [
  'openai/gpt-oss-120b',   // reemplazo recomendado de llama-3.3-70b-versatile (deprecado jun-2026)
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-20b'
];

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-4-maverick:free',
  'google/gemini-flash-1.5:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free'
];

async function callGroq(apiKey, model, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

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

  const groqKey = env.GROQ_API_KEY;
  const orKey   = env.OPENROUTER_API_KEY;

  if (!groqKey && !orKey) {
    return new Response(
      JSON.stringify({ error: 'No hay ninguna API key configurada (GROQ_API_KEY ni OPENROUTER_API_KEY).' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { messages } = body;
  if (!messages?.length) {
    return new Response(JSON.stringify({ error: 'Falta messages' }), { status: 400 });
  }

  let lastError = null;

  // 1) Groq primero
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try { result = await callGroq(groqKey, model, messages); }
      catch (err) { lastError = 'Groq: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return new Response(
          JSON.stringify({ reply, modelUsed: `Groq · ${model}` }),
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }
      lastError = result.data.error?.message || `Groq ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  // 2) OpenRouter como respaldo
  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages); }
      catch (err) { lastError = 'OpenRouter: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return new Response(
          JSON.stringify({ reply, modelUsed: `OpenRouter · ${model}` }),
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  return new Response(
    JSON.stringify({
      error: 'Todos los motores de IA gratuitos están saturados en este momento. Probá de nuevo en unos minutos. (' + lastError + ')'
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
