// Cloudflare Pages Function — /api/search
// Búsqueda web real vía Brave Search API (gratis: 2000 búsquedas/mes).
// Variable de entorno requerida: BRAVE_API_KEY

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  const apiKey = context.env.BRAVE_API_KEY;
  if (!apiKey) return jsonRes(500, { error: 'BRAVE_API_KEY no configurada.' });

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { query } = body;
  if (!query?.trim()) return jsonRes(400, { error: 'Falta query.' });

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6&search_lang=es&ui_lang=es-AR&country=AR`;
    const res  = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey
      }
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return jsonRes(res.status, { error: `Brave Search error ${res.status}: ${err}` });
    }

    const data    = await res.json();
    const results = (data.web?.results || []).map(r => ({
      title:       r.title       || '',
      url:         r.url         || '',
      description: r.description || ''
    }));

    return jsonRes(200, { results, query });
  } catch (err) {
    return jsonRes(500, { error: 'Error en búsqueda: ' + err.message });
  }
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
