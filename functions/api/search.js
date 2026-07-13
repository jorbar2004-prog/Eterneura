// Cloudflare Pages Function — /api/search
// Búsqueda web real vía Serper.dev (gratis: 2500 búsquedas).
// Variable de entorno requerida: SERPER_API_KEY

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  const apiKey = context.env.SERPER_API_KEY;
  if (!apiKey) return jsonRes(500, { error: 'SERPER_API_KEY no configurada.' });

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { query } = body;
  if (!query?.trim()) return jsonRes(400, { error: 'Falta query.' });

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 6 })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return jsonRes(res.status, { error: `Serper error ${res.status}: ${err}` });
    }
    const data    = await res.json();
    const results = (data.organic || []).map(r => ({
      title: r.title || '', url: r.link || '', description: r.snippet || ''
    }));
    return jsonRes(200, { results, query });
  } catch (err) {
    return jsonRes(500, { error: 'Error en búsqueda: ' + err.message });
  }
}

export async function onRequestOptions() {
  return new Response('', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
}
