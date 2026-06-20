export async function onRequestPost({ request, env }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY no configurada.' }), {
    status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { messages, model = 'meta-llama/llama-3.3-70b-instruct:free' } = body;
  if (!messages?.length) return new Response(JSON.stringify({ error: 'Falta messages' }), { status: 400 });

  let aiRes;
  try {
    aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://eternaura.pages.dev',
        'X-Title': 'Eternaura'
      },
      body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'No se pudo conectar: ' + err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const data = await aiRes.json();
  if (!aiRes.ok) return new Response(JSON.stringify({ error: data.error?.message || 'Error del modelo' }), {
    status: aiRes.status, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  return new Response(JSON.stringify({ reply: data.choices?.[0]?.message?.content || 'Sin respuesta.' }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}
