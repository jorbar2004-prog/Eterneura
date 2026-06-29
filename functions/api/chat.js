// Cloudflare Pages Function — responde en /api/chat
//
// ── Motores de IA, en orden de preferencia ──
// Para texto: 1) Groq (gratis, ~14.400 msj/día)  2) OpenRouter (respaldo)
// Para imágenes (visión): OpenRouter, con modelos gratuitos de visión.

// Modelos Groq: nombres exactos según https://console.groq.com/docs/models
// IMPORTANTE: Groq usa IDs propios, NO los prefijos openai/ o qwen/ de OpenRouter.
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // modelo principal — máxima calidad
  'llama-3.1-70b-versatile',   // alternativa estable
  'gemma2-9b-it'               // respaldo liviano — muy confiable
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

async function callGroq(apiKey, model, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 2200, temperature: 0.7 })
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
      'X-Title': 'Eterneura'
    },
    body: JSON.stringify({ model, messages, max_tokens: 2200, temperature: 0.7 })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
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
  const orKey   = context.env.OPENROUTER_API_KEY;

  if (!groqKey && !orKey)
    return jsonRes(500, { error: 'No hay ninguna API key configurada (GROQ_API_KEY ni OPENROUTER_API_KEY).' });

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { messages, hasImages } = body;
  if (!messages?.length) return jsonRes(400, { error: 'Falta messages' });

  if (hasImages && !orKey)
    return jsonRes(500, { error: 'El análisis de imágenes requiere una OPENROUTER_API_KEY configurada.' });

  let lastError = null;

  if (hasImages) {
    for (const model of OPENROUTER_VISION_MODELS) {
      let result;
      try { result = await callOpenRouter(orKey, model, messages); }
      catch (err) { lastError = 'OpenRouter (visión): ' + err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return jsonRes(200, { reply, modelUsed: `OpenRouter · ${model}` });
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
    return jsonRes(429, { error: 'Los modelos de visión están saturados. Intentá de nuevo en unos minutos. (' + lastError + ')' });
  }

  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let result;
      try { result = await callGroq(groqKey, model, messages); }
      catch (err) { lastError = 'Groq: ' + err.message; continue; }
      if (result.ok) {
        const reply = result.data.choices?.[0]?.message?.content || 'Sin respuesta.';
        return jsonRes(200, { reply, modelUsed: `Groq · ${model}` });
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
        return jsonRes(200, { reply, modelUsed: `OpenRouter · ${model}` });
      }
      lastError = result.data.error?.message || `OpenRouter ${result.status} (${model})`;
      if (result.status !== 429 && result.status !== 404) break;
    }
  }

  return jsonRes(429, { error: 'Todos los motores gratuitos están saturados. Intentá en unos minutos. (' + lastError + ')' });
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
