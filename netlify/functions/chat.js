// Netlify Function — responde en /.netlify/functions/chat (redirigido desde /api/chat).
//
// ── Motores de IA, en orden de preferencia ──
// Para texto: 1) Groq (gratis, ~14.400 msj/día)  2) OpenRouter (respaldo)
// Para imágenes (visión): OpenRouter, con modelos gratuitos de visión.
// Groq no tiene buena cobertura de visión gratuita, así que las consultas
// con imagen van directo a OpenRouter.

// Modelos Groq: nombres exactos según https://console.groq.com/docs/models
// IMPORTANTE: Groq usa IDs propios, NO los prefijos openai/ o qwen/ de OpenRouter.
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // modelo principal de texto — máxima calidad
  'llama3-70b-8192',           // alternativa estable, contexto largo
  'mixtral-8x7b-32768'         // respaldo — muy bueno y con contexto extendido
];

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-4-maverick:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free'
];

// Modelos gratuitos de OpenRouter con soporte de visión (imagen + texto).
const OPENROUTER_VISION_MODELS = [
  'qwen/qwen2.5-vl-72b-instruct:free',
  'qwen/qwen2.5-vl-32b-instruct:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'google/gemma-3-27b-it:free'
];

async function callGroq(apiKey, model, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 2200, temperature: 0.7 })
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
      'HTTP-Referer': 'https://eterneura.netlify.app',
      'X-Title': 'Eterneura'
    },
    body: JSON.stringify({ model, messages, max_tokens: 2200, temperature: 0.7 })
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
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { messages, hasImages } = body;
  if (!messages?.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Falta messages' }) };

  if (hasImages && !orKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'El análisis de imágenes requiere una OPENROUTER_API_KEY configurada (Groq no soporta visión en el plan gratuito).' })
    };
  }

  let lastError = null;

  // ── Camino con imágenes: directo a OpenRouter con modelos de visión ──
  if (hasImages) {
    for (const model of OPENROUTER_VISION_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages); }
      catch (err) { lastError = 'OpenRouter (visión): ' + err.message; continue; }

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

    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Los modelos gratuitos con visión están saturados o no disponibles en este momento. Probá de nuevo en unos minutos. (' + lastError + ')' })
    };
  }

  // ── Camino normal (solo texto): Groq primero, OpenRouter como respaldo ──
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
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

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
    body: JSON.stringify({ error: 'Todos los motores de IA gratuitos están saturados en este momento. Probá de nuevo en unos minutos. (' + lastError + ')' })
  };
};
