/**
 * GET /api/auction
 * Public, safe status for the gear cards: open/closed/sponsored only. Never
 * returns bids, bidders or emails. Also nudges the scheduled work (closing,
 * reminders) on a cache miss, so a visit or the 5-minute job keeps it moving.
 */
import { publicStatus, tick } from "../_lib/auction.js";
import { AUCTION_CLOSES_MS, DAY_MS } from "../_lib/auction-config.js";

const HEADERS = { "content-type": "application/json", "cache-control": "public, max-age=30" };

export async function onRequestGet(context) {
  const { env, request } = context;
  const now = Date.now();
  const cache = globalThis.caches?.default;
  const key = new Request(new URL("/api/auction", request.url).toString());

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, { status: 200, headers: HEADERS });
    } catch { /* fall through to live */ }
  }

  if (now >= AUCTION_CLOSES_MS - DAY_MS) {
    context.waitUntil(tick(env, now).catch(e => console.error("auction_tick_failed", String(e && e.message || e))));
  }

  const body = JSON.stringify(await publicStatus(env, now));
  if (cache) {
    context.waitUntil(cache.put(key, new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    })).catch(() => {}));
  }
  return new Response(body, { status: 200, headers: HEADERS });
}
