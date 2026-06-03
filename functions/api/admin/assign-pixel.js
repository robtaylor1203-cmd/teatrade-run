/**
 * POST /api/admin/assign-pixel
 * --------------------------------------------------------------
 * Manual reconciliation: attach an existing GiveWheel donation
 * (which is already counted in raised_total) to a specific mile
 * pixel. Use this when the donor didn't return through our
 * pending flow, e.g. they donated direct on the GiveWheel page,
 * or the pending lock expired before they paid.
 *
 * Body:
 *   { secret: "...", pixel: 63, gw_id: "12345",
 *     sponsor_name?: "Rob", message?: "Go!", donor_type?: "individual",
 *     tier?: "standard" }
 *
 * Secret is checked against env.ADMIN_SECRET.
 */
export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_SECRET) return j({ error: "admin_disabled" }, 500);

  let body;
  try { body = await request.json(); } catch { return j({ error: "bad_json" }, 400); }
  if (body.secret !== env.ADMIN_SECRET) return j({ error: "forbidden" }, 403);

  const pixel = parseInt(body.pixel, 10);
  const gwId  = String(body.gw_id || "").trim();
  if (!pixel || pixel < 1 || pixel > 190) return j({ error: "bad_pixel" }, 400);
  if (!gwId) return j({ error: "bad_gw_id" }, 400);

  const raw = await env.SPONSORSHIPS_KV.get("data");
  const data = raw ? JSON.parse(raw) : {};
  data.sponsorships     = data.sponsorships     || [];
  data.pending          = data.pending          || [];
  data.orphan_donations = data.orphan_donations || [];

  if (data.sponsorships.some(s => s.pixel === pixel)) {
    return j({ error: "pixel_already_claimed" }, 409);
  }
  if (data.sponsorships.some(s => String(s.gw_id) === gwId)) {
    return j({ error: "donation_already_attributed" }, 409);
  }

  const orphan = data.orphan_donations.find(o => String(o.gw_id) === gwId);
  const tier   = body.tier || "standard";
  const donorType = body.donor_type || "individual";
  const sponsorName = body.sponsor_name || orphan?.name || "Anonymous";
  const message     = body.message     || orphan?.message || "";
  const amount      = orphan?.amount   || parseInt(body.amount, 10) || 0;

  data.sponsorships.push({
    pixel,
    sponsor:  sponsorName,
    initials: initialsFor(sponsorName),
    logo:     body.logo_url || "",
    logoBg:   donorType === "corporate" ? "#202124"
            : (tier === "premium"  ? "#c5a572"
            : (tier === "featured" ? "#1a73e8"
            : "#f56600")),
    amount,
    tier,
    message,
    gw_id:        gwId,
    confirmed_ms: Date.now(),
    manually_assigned: true,
  });

  // Remove from pending and orphans if present.
  data.pending          = data.pending.filter(p => p.pixel !== pixel);
  data.orphan_donations = data.orphan_donations.filter(o => String(o.gw_id) !== gwId);

  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

  return j({ ok: true, pixel, gw_id: gwId, amount });
}

function initialsFor(name) {
  return (name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}

function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
