// Netlify Function — /api/shazam
// Identificación de canciones vía ACRCloud (plan gratuito).
// Recibe audio en base64 desde el frontend, lo envía a ACRCloud y devuelve
// título, artista, álbum y otros metadatos.
// Variables de entorno requeridas:
//   ACRCLOUD_HOST     → ej: identify-eu-west-1.acrcloud.com
//   ACRCLOUD_KEY      → Access Key de tu proyecto
//   ACRCLOUD_SECRET   → Access Secret de tu proyecto
//
// Cómo obtenerlas (gratis):
//   1. Registrarse en https://www.acrcloud.com/
//   2. Console → Projects → Create Project → "Audio & Video Recognition"
//   3. Copiar el Host, Access Key y Access Secret.

const crypto = require('crypto');

function sign(method, uri, accessKey, dataType, signatureVersion, timestamp, secret) {
  const str = [method, uri, accessKey, dataType, signatureVersion, timestamp].join('\n');
  return crypto.createHmac('sha1', secret).update(str).digest('base64');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, body: 'Method Not Allowed' };

  const host    = process.env.ACRCLOUD_HOST;
  const key     = process.env.ACRCLOUD_KEY;
  const secret  = process.env.ACRCLOUD_SECRET;

  if (!host || !key || !secret) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'Credenciales de ACRCloud no configuradas (ACRCLOUD_HOST, ACRCLOUD_KEY, ACRCLOUD_SECRET).' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { audioBase64, mimeType } = body;
  if (!audioBase64) return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ error: 'Falta audioBase64.' })
  };

  // Convertir base64 → Buffer
  const audioBuffer = Buffer.from(audioBase64, 'base64');

  // Construir firma ACRCloud
  const timestamp    = Math.floor(Date.now() / 1000);
  const reqUri       = '/v1/identify';
  const dataType     = 'audio';
  const sigVersion   = '1';
  const signature    = sign('POST', reqUri, key, dataType, sigVersion, timestamp, secret);

  // Construir multipart/form-data manualmente
  const boundary = '----AcrCloudBoundary' + Date.now().toString(36);
  const ext      = (mimeType || 'audio/mpeg').split('/')[1]?.split(';')[0] || 'mp3';
  const filename = `sample.${ext}`;

  const fieldParts = [
    ['access_key',          key],
    ['data_type',           dataType],
    ['signature_version',   sigVersion],
    ['signature',           signature],
    ['sample_bytes',        String(audioBuffer.length)],
    ['timestamp',           String(timestamp)]
  ];

  const CRLF = '\r\n';
  let formBuf = Buffer.alloc(0);

  for (const [name, value] of fieldParts) {
    const part = Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      'utf8'
    );
    formBuf = Buffer.concat([formBuf, part]);
  }

  // Campo de audio (binario)
  const audioHeader = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="sample"; filename="${filename}"${CRLF}Content-Type: ${mimeType || 'audio/mpeg'}${CRLF}${CRLF}`,
    'utf8'
  );
  const audioClose = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
  formBuf = Buffer.concat([formBuf, audioHeader, audioBuffer, audioClose]);

  try {
    const res = await fetch(`https://${host}${reqUri}`, {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(formBuf.length)
      },
      body: formBuf
    });

    const data = await res.json().catch(() => ({}));

    if (data.status?.code === 0 && data.metadata?.music?.length) {
      const track   = data.metadata.music[0];
      const artists = (track.artists || []).map(a => a.name).join(', ');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          found:    true,
          title:    track.title    || '',
          artist:   artists        || '',
          album:    track.album?.name || '',
          year:     track.release_date?.slice(0, 4) || '',
          genre:    (track.genres?.split(',')[0] || '').trim(),
          score:    track.score    || 0,
          label:    track.label    || '',
          external: track.external_metadata || {}
        })
      };
    }

    // No encontrado (code 1001) u otro error de ACRCloud
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        found:   false,
        code:    data.status?.code,
        message: data.status?.msg || 'No se identificó ninguna canción.'
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Error al contactar ACRCloud: ' + err.message })
    };
  }
};
