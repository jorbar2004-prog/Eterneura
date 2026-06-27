// ATEN Responde — Netlify Function v2 con fetch a aten.org.ar
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

// Extraer texto limpio de HTML
function extraerTexto(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 3000);
}

// Buscar en aten.org.ar
async function buscarEnATEN(pregunta) {
  const urls = [
    'https://aten.org.ar/',
    'https://aten.org.ar/noticias/',
    'https://aten.org.ar/comunicados/',
    'https://aten.org.ar/estatuto/',
  ];

  const q = pregunta.toLowerCase();
  const esPreguntaDeNovedad = /noticia|comunicado|paro|huelga|asamblea|acuerdo|salarial|aumento|marcha|moviliz|convocator|reciente|último|hoy|semana/.test(q);
  const esPreguntaEstatuto = /estatuto|articulo|ley 1124|licencia|puntaje|junta|antigüedad|titular|interino|suplente/.test(q);

  const urlsAConsultar = esPreguntaEstatuto
    ? ['https://aten.org.ar/', 'https://aten.org.ar/estatuto/']
    : esPreguntaDeNovedad
    ? ['https://aten.org.ar/', 'https://aten.org.ar/noticias/', 'https://aten.org.ar/comunicados/']
    : ['https://aten.org.ar/'];

  let contexto = '';
  for (const url of urlsAConsultar) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'ATEN-Responde-Bot/1.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) continue;
      const html = await r.text();
      const texto = extraerTexto(html);
      if (texto.length > 100) {
        contexto += `\n[Fuente: ${url}]\n${texto.slice(0, 1200)}\n`;
        if (contexto.length > 2500) break;
      }
    } catch { continue; }
  }
  return contexto;
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
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return JSON.parse(content);
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
    body: JSON.stringify({
      message: 'Update KB desde panel admin ATEN Responde',
      content,
      sha: current.sha
    })
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

  // Buscar en paralelo: KB verificada + aten.org.ar
  const [kb, contextoATEN] = await Promise.all([
    getKB(ghToken, ghRepo),
    buscarEnATEN(preguntaUsuario)
  ]);

  const verificada = buscarEnKB(kb, preguntaUsuario);
  const sysIdx = messages.findIndex(m => m.role === 'system');

  if (sysIdx >= 0) {
    let extra = '';
    if (verificada) {
      extra += `\n\nRESPUESTA VERIFICADA POR ATEN (PRIORIDAD MÁXIMA):\nPregunta: "${verificada.pregunta}"\nRespuesta oficial: "${verificada.respuestaVerificada}"`;
    }
    if (contextoATEN) {
      extra += `\n\nCONTENIDO ACTUAL DE ATEN.ORG.AR (usá esta info para noticias y novedades recientes, citá la fuente):\n${contextoATEN}`;
    }
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
