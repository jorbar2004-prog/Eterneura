exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'OPENROUTER_API_KEY no configurada en variables de entorno.' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { messages, model = 'meta-llama/llama-3.3-70b-instruct:free' } = body;
  if (!messages?.length) return { statusCode: 400, body: JSON.stringify({ error: 'Falta messages' }) };

  let aiResponse;
  try {
    aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://eternaura.netlify.app',
        'X-Title': 'Eternaura'
      },
      body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
    });
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'No se pudo conectar con OpenRouter: ' + err.message }) };
  }

  const data = await aiResponse.json();
  if (!aiResponse.ok) return {
    statusCode: aiResponse.status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: data.error?.message || 'Error del modelo' })
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ reply: data.choices?.[0]?.message?.content || 'Sin respuesta.' })
  };
};
