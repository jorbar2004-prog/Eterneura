// Cloudflare Pages Function — responde en /api/image
// Genera imágenes REALISTAS (no diagramas esquemáticos) usando Cloudflare Workers AI.
//
// Requiere un binding de Workers AI en este proyecto de Cloudflare Pages:
//   Settings → Functions → AI bindings → Add binding → variable name: AI
// No requiere ninguna API key nueva: usa la misma cuenta de Cloudflare donde
// ya está alojado el sitio. Cuota gratis: 10.000 neurons/día (~230 imágenes
// con FLUX.1 Schnell).
//
// Esta función solo existe en la versión de Cloudflare. En Netlify no hay
// equivalente gratuito a Workers AI, así que ese deploy no tendrá esta
// capacidad (el frontend lo detecta y avisa con un mensaje claro).

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

// Filtro de seguridad básico a nivel de prompt: contenido educativo solamente.
// No reemplaza los filtros propios del modelo, es una capa adicional.
const BLOCKED_TERMS = [
  'nude', 'naked', 'nsfw', 'sex', 'porn', 'gore', 'corpse', 'dead body',
  'desnud', 'sexual', 'violencia explícita', 'sangre explícita'
];

function isPromptSafe(prompt) {
  const lower = prompt.toLowerCase();
  return !BLOCKED_TERMS.some(term => lower.includes(term));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (!env.AI) {
    return new Response(
      JSON.stringify({
        error: 'La generación de imágenes realistas no está habilitada en este sitio. El docente debe activar el binding "AI" de Workers AI en Cloudflare (Settings → Functions → AI bindings).'
      }),
      { status: 501, headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: cors }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Falta el prompt de la imagen' }), { status: 400, headers: cors });
  }
  if (prompt.length > 600) {
    return new Response(JSON.stringify({ error: 'Prompt demasiado largo' }), { status: 400, headers: cors });
  }
  if (!isPromptSafe(prompt)) {
    return new Response(JSON.stringify({ error: 'Este pedido de imagen no cumple las pautas de contenido educativo del sitio.' }), { status: 400, headers: cors });
  }

  try {
    const result = await env.AI.run(IMAGE_MODEL, { prompt, seed: Math.floor(Math.random() * 100000) });

    // FLUX.1 Schnell en Workers AI devuelve { image: "<base64>" } (JPEG/PNG base64, sin prefijo data:)
    const base64 = result.image;
    if (!base64) throw new Error('El modelo no devolvió una imagen');

    return new Response(
      JSON.stringify({ image: `data:image/jpeg;base64,${base64}` }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'No se pudo generar la imagen: ' + err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
