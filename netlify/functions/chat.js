// ── Motores de IA, en orden de preferencia ──
// 1) Groq: gratis, sin tarjeta, ~14.400 mensajes/día. Motor principal.
// 2) OpenRouter: respaldo si Groq también falla o no está configurado.
//    Útil porque ambos planes gratuitos son independientes entre sí.

const GROQ_MODELS = [
  'openai/gpt-oss-120b',   // reemplazo recomendado de llama-3.3-70b-versatile (deprecado jun-2026)
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-20b'     // más liviano, último recurso dentro de Groq
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
  return { ok: res.ok, status: res.status, data, provider: 'Groq' };
}

async function callOpenRouter(apiKey, model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eternaura.netlify.app',
      'X-Title': 'Eternaura'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, provider: 'OpenRouter' };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const groqKey = process.env.GROQ_API_KEY;
  const orKey   = process.env.OPENROUTER_API_KEY;

  if (!groqKey && !orKey) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'No hay ninguna API key configurada (GROQ_API_KEY ni OPENROUTER_API_KEY).' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { messages } = body;
  if (!messages?.length) return { statusCode: 400, body: JSON.stringify({ error: 'Falta messages' }) };

  let lastError = null;

  // 1) Probar Groq primero (mayor cuota gratis diaria)
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try { result = await callGroq(groqKey, model, messages); }
      catch (err) { lastError = 'Groq: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
          body: JSON.stringify({ reply, modelUsed: `Groq · ${model}` })
        };
      }
      lastError = result.data.error?.message || `Groq ${result.status} (${model})`;
      // 429 (saturado) o 404 (modelo no disponible): seguir probando.
      if (result.status !== 429 && result.status !== 404) break; // error real (ej. key inválida): no insistir en Groq
    }
  }

  // 2) Si Groq no está configurado o falló en todos sus modelos, probar OpenRouter
  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages); }
      catch (err) { lastError = 'OpenRouter: ' + err.message; continue; }

      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
          body: JSON.stringify({ reply, modelUsed: `OpenRouter · ${model}` })
        };
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  return {
    statusCode: 429,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({
      error: 'Todos los motores de IA gratuitos están saturados en este momento. Probá de nuevo en unos minutos. (' + lastError + ')'
    })
  };
};
