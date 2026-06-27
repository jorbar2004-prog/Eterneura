// ATEN Responde — Netlify Function v4 con WordPress REST API
const GROQ_MODELS = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.3-70b-versatile',
  'llama3-70b-8192'
];
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'qwen/qwen2.5-72b-instruct:free'
];

function limpiarRespuesta(texto) {
  return (texto || 'Sin respuesta.')
    .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function stripHTML(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8230;/g, '...')
    .replace(/\s{2,}/g, ' ').trim();
}

async function obtenerNoticiasATEN() {
  const endpoints = [
    'https://aten.org.ar/wp-json/wp/v2/posts?per_page=8&_fields=title,date,excerpt,link',
    'https://aten.org.ar/wp-json/wp/v2/posts?per_page=8',
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ATENResponde/1.0)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(7000)
      });
      if (!r.ok) continue;
      const posts = await r.json();
      if (!Array.isArray(posts) || !posts.length) continue;

      let contexto = `NOTICIAS RECIENTES DE ATEN NEUQUÉN (fuente: aten.org.ar):\n`;
      for (const post of posts.slice(0, 8)) {
        const titulo = stripHTML(post.title?.rendered || post.title || '');
        const fecha = (post.date || '').slice(0, 10);
        const resumen = stripHTML(post.excerpt?.rendered || '').slice(0, 180);
        if (titulo) {
          contexto += `\n• ${titulo}`;
          if (fecha) contexto += ` (${fecha})`;
          if (resumen) contexto += `\n  ${resumen}`;
        }
      }
      return contexto;
    } catch { continue; }
  }
  return '';
}

async function callGroq(k, model, messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.4 })
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function callOR(k, model, messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${k}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://aten-tep-responde.netlify.app',
      'X-Title': 'ATEN Responde'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.4 })
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function getKB(ghToken, ghRepo) {
  if (!ghToken || !ghRepo) return [];
  try {
    const r = await fetch(`https://api.github.com/repos/${ghRepo}/contents/data/kb.json`, {
      headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch { return []; }
}

async function saveKB(ghToken, ghRepo, kb) {
  const r = await fetch(`https://api.github.com/repos/${ghRepo}/contents/data/kb.json`, {
    headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!r.ok) return false;
  const current = await r.json();
  const content = Buffer.from(JSON.stringify(kb, null, 2)).toString('base64');
  const upd = await fetch(`https://api.github.com/repos/${ghRepo}/contents/data/kb.json`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Update KB ATEN Responde', content, sha: current.sha })
  });
  return upd.ok;
}

function buscarEnKB(kb, pregunta) {
  if (!kb?.length) return null;
  const q = pregunta.toLowerCase();
  const stopwords = new Set(['para','que','con','una','los','las','del','por','como','más','pero','sobre','esta','este','ese','cómo','cuál','qué','cuándo','cuánto']);
  const palabras = q.split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
  let mejor = null, maxScore = 0;
  for (const item of kb) {
    if (!item.respuestaVerificada) continue;
    const texto = (item.pregunta + ' ' + (item.temas || []).join(' ')).toLowerCase();
    let score = 0;
    for (const p of palabras) if (texto.includes(p)) score++;
    if (score > maxScore) { maxScore = score; mejor = item; }
  }
  return maxScore >= 2 ? mejor : null;
}

function esConsultaDeNoticias(pregunta) {
  return /noticia|comunicado|paro|huelga|asamblea|acuerdo|salarial|aumento|marcha|moviliz|convocator|reciente|último|hoy|semana|medida.*fuerza|fuerza.*medida|novedad|acontec|pasó|ocurrió|aten.*dice|aten.*inform|informa/.test(pregunta.toLowerCase());
}

exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const groqKey  = process.env.GROQ_API_KEY;
  const orKey    = process.env.OPENROUTER_API_KEY;
  const ghToken  = process.env.GITHUB_TOKEN;
  const ghRepo   = process.env.GITHUB_REPO;
  const adminPwd = process.env.ADMIN_PASSWORD || 'aten2024';

  if (!groqKey && !orKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'No hay API key configurada.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  if (body.action === 'saveKB') {
    if (body.password !== adminPwd) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Contraseña incorrecta' }) };
    const ok = await saveKB(ghToken, ghRepo, body.kb);
    return { statusCode: ok ? 200 : 500, headers: cors, body: JSON.stringify({ ok }) };
  }

  if (body.action === 'getKB') {
    if (body.password !== adminPwd) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Contraseña incorrecta' }) };
    const kb = await getKB(ghToken, ghRepo);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ kb }) };
  }

  const { messages } = body;
  if (!messages?.length) return { statusCode: 400, body: JSON.stringify({ error: 'Falta messages' }) };

  const preguntaUsuario = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  const [kb, noticiasATEN] = await Promise.all([
    getKB(ghToken, ghRepo),
    esConsultaDeNoticias(preguntaUsuario) ? obtenerNoticiasATEN() : Promise.resolve('')
  ]);

  const verificada = buscarEnKB(kb, preguntaUsuario);
  const sysIdx = messages.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    let extra = '';
    if (verificada) extra += `\n\nRESPUESTA VERIFICADA POR ATEN (PRIORIDAD MÁXIMA):\nPregunta: "${verificada.pregunta}"\nRespuesta oficial: "${verificada.respuestaVerificada}"`;
    if (noticiasATEN) extra += `\n\n${noticiasATEN}\n\nUsá estas noticias para responder. Citá siempre aten.org.ar como fuente.`;
    if (extra) messages[sysIdx].content += extra;
  }

  let lastError = null;

  if (groqKey) {
    for (const model of GROQ_MODELS) {
      let r;
      try { r = await callGroq(groqKey, model, messages); } catch(e) { lastError = e.message; continue; }
      if (r.ok) return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: limpiarRespuesta(r.data.choices?.[0]?.message?.content) }) };
      lastError = r.data.error?.message || `Groq ${r.status}`;
      if (r.status !== 429 && r.status !== 404) break;
    }
  }

  if (orKey) {
    for (const model of OPENROUTER_MODELS) {
      let r;
      try { r = await callOR(orKey, model, messages); } catch(e) { lastError = e.message; continue; }
      if (r.ok) return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: limpiarRespuesta(r.data.choices?.[0]?.message?.content) }) };
      lastError = r.data.error?.message || `OR ${r.status}`;
      if (r.status !== 429 && r.status !== 404) break;
    }
  }

  return { statusCode: 429, headers: cors, body: JSON.stringify({ error: `Todos los motores saturados. (${lastError})` }) };
};
