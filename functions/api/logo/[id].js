/**
 * GET /api/logo/<code>
 * Serves a sponsor logo stored in KV as a validated data URL. Keeping logos
 * out of /api/sponsorships keeps that poll small and lets browsers cache them.
 */
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

export async function onRequestGet({ params, env }) {
  const id = String(params.id || "");
  if (!ID.test(id)) return new Response("Not found", { status: 404 });

  const stored = await env.SPONSORSHIPS_KV.get(`logo:${id}`);
  const m = stored && DATA_URL.exec(stored);
  if (!m) return new Response("Not found", { status: 404 });

  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "content-type":           m[1],
      "cache-control":          "public, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      // Stops scripts in an SVG running if someone opens the URL directly.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
