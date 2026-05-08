/**
 * GET /api/sponsorships
 * --------------------------------------------------------------
 * Public read endpoint the front-end polls so the map / total /
 * claimed counter stay in sync without the user refreshing.
 * Returns a trimmed view (no pending rows, no contact emails).
 */
export async function onRequestGet({ env }) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  const data = raw
    ? JSON.parse(raw)
    : { sponsorships: [], raised_total: 0, raised_goal: 19000, updated: null };

  return new Response(JSON.stringify({
    updated:      data.updated,
    raised_total: data.raised_total || 0,
    raised_goal:  data.raised_goal  || 19000,
    sponsorships: (data.sponsorships || []).map(s => ({
      pixel:    s.pixel,
      sponsor:  s.sponsor,
      initials: s.initials,
      logo:     s.logo,
      logoBg:   s.logoBg,
      amount:   s.amount,
      tier:     s.tier,
      message:  s.message,
    })),
    pending_pixels: (data.pending || []).map(p => p.pixel),
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15",
      "access-control-allow-origin": "*",
    },
  });
}
