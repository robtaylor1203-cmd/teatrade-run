/**
 * GET  /api/admin/auction   all confirmed bids per item + results (admin only)
 * POST /api/admin/auction   { action: "offer", item, bid_key, days? }
 *
 * Authenticated with the x-admin-secret header. Bids and bidder emails are
 * never exposed anywhere else.
 */
import { adminOverview, adminOffer } from "../../_lib/auction.js";
import { safeEqual } from "../../_lib/sponsor.js";

const authed = (request, env) =>
  !!env.ADMIN_SECRET && safeEqual(request.headers.get("x-admin-secret") || "", env.ADMIN_SECRET);

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ error: "forbidden" }, 403);
  return json(await adminOverview(env, Date.now()));
}

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ error: "forbidden" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (body?.action !== "offer") return json({ error: "bad_action" }, 400);

  const res = await adminOffer(env, { itemId: body.item, bidKey: body.bid_key, days: body.days }, Date.now());
  return json(res, res.error ? 400 : 200);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
