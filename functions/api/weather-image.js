export async function onRequestGet({ request }) {
  const { searchParams } = new URL(request.url);
  const src = searchParams.get('url');
  if (!src) return new Response('Missing url param', { status: 400 });

  // Solo permitimos proxear estos dos dominios, por seguridad
  const allowed = ['smn.gob.ar', 'cdn.star.nesdis.noaa.gov'];
  let hostname;
  try {
    hostname = new URL(src).hostname;
  } catch {
    return new Response('Invalid url', { status: 400 });
  }
  if (!allowed.some(d => hostname.endsWith(d))) {
    return new Response('Domain not allowed', { status: 403 });
  }

  try {
    const upstream = await fetch(src, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EterneuraBot/1.0)' }
    });
    if (!upstream.ok) return new Response('Upstream error', { status: 502 });

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response('Fetch failed', { status: 502 });
  }
}
