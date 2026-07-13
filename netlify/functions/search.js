// Netlify Function — /api/search
// Búsqueda web real vía Serper.dev (gratis: 2500 búsquedas).
// Variable de entorno requerida: SERPER_API_KEY

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'SERPER_API_KEY no configurada.' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { query } = body;
  if (!query?.trim()) return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'Falta query.' })
  };

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 6 })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return { statusCode: res.status, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: `Serper error ${res.status}: ${err}` }) };
    }
    const data    = await res.json();
    const results = (data.organic || []).map(r => ({
      title: r.title || '', url: r.link || '', description: r.snippet || ''
    }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ results, query }) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Error en búsqueda: ' + err.message }) };
  }
};
