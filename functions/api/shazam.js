// Cloudflare Pages Function — /api/shazam
// Identificación de canciones vía ACRCloud (plan gratuito).
// Variables de entorno: ACRCLOUD_HOST, ACRCLOUD_KEY, ACRCLOUD_SECRET

// Firma HMAC-SHA1 usando Web Crypto API (disponible en Cloudflare Workers)
async function sign(method, uri, accessKey, dataType, signatureVersion, timestamp, secret) {
  const str     = [method, uri, accessKey, dataType, signatureVersion, timestamp].join('\n');
  const keyData = new TextEncoder().encode(secret);
  const msgData = new TextEncoder().encode(str);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig       = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const jsonRes = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  const host   = context.env.ACRCLOUD_HOST;
  const key    = context.env.ACRCLOUD_KEY;
  const secret = context.env.ACRCLOUD_SECRET;

  if (!host || !key || !secret)
    return jsonRes(500, { error: 'Credenciales de ACRCloud no configuradas.' });

  let body;
  try { body = await context.request.json(); }
  catch { return jsonRes(400, { error: 'JSON inválido' }); }

  const { audioBase64, mimeType } = body;
  if (!audioBase64) return jsonRes(400, { error: 'Falta audioBase64.' });

  // base64 → Uint8Array
  const binaryStr  = atob(audioBase64);
  const audioBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) audioBytes[i] = binaryStr.charCodeAt(i);

  const timestamp  = Math.floor(Date.now() / 1000);
  const reqUri     = '/v1/identify';
  const dataType   = 'audio';
  const sigVersion = '1';
  const signature  = await sign('POST', reqUri, key, dataType, sigVersion, timestamp, secret);

  const boundary = '----AcrCloudBoundary' + Date.now().toString(36);
  const ext      = (mimeType || 'audio/mpeg').split('/')[1]?.split(';')[0] || 'mp3';
  const filename = `sample.${ext}`;

  const CRLF = '\r\n';
  const enc  = s => new TextEncoder().encode(s);

  const fields = [
    ['access_key',        key],
    ['data_type',         dataType],
    ['signature_version', sigVersion],
    ['signature',         signature],
    ['sample_bytes',      String(audioBytes.length)],
    ['timestamp',         String(timestamp)]
  ];

  const parts = [];
  for (const [name, value] of fields) {
    parts.push(enc(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
  }
  parts.push(enc(`--${boundary}${CRLF}Content-Disposition: form-data; name="sample"; filename="${filename}"${CRLF}Content-Type: ${mimeType || 'audio/mpeg'}${CRLF}${CRLF}`));
  parts.push(audioBytes);
  parts.push(enc(`${CRLF}--${boundary}--${CRLF}`));

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const formBuf  = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { formBuf.set(p, offset); offset += p.length; }

  try {
    const res  = await fetch(`https://${host}${reqUri}`, {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(totalLen)
      },
      body: formBuf
    });

    const data = await res.json().catch(() => ({}));

    if (data.status?.code === 0 && data.metadata?.music?.length) {
      const track   = data.metadata.music[0];
      const artists = (track.artists || []).map(a => a.name).join(', ');
      return jsonRes(200, {
        found:    true,
        title:    track.title        || '',
        artist:   artists            || '',
        album:    track.album?.name  || '',
        year:     track.release_date?.slice(0, 4) || '',
        genre:    (track.genres?.split(',')[0] || '').trim(),
        score:    track.score        || 0,
        label:    track.label        || '',
        external: track.external_metadata || {}
      });
    }

    return jsonRes(200, {
      found:   false,
      code:    data.status?.code,
      message: data.status?.msg || 'No se identificó ninguna canción.'
    });
  } catch (err) {
    return jsonRes(500, { error: 'Error al contactar ACRCloud: ' + err.message });
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
