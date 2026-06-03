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
 *     tier?: "standard", logo_url?: "https://...",
 *     force?: true  // overwrite if the pixel is already taken
 *   }
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
  const force = body.force === true;
  if (!pixel || pixel < 1 || pixel > 190) return j({ error: "bad_pixel" }, 400);
  if (!gwId) return j({ error: "bad_gw_id" }, 400);

  const raw = await env.SPONSORSHIPS_KV.get("data");
  const data = raw ? JSON.parse(raw) : {};
  data.sponsorships     = data.sponsorships     || [];
  data.pending          = data.pending          || [];
  data.orphan_donations = data.orphan_donations || [];

  const existingPixelIdx    = data.sponsorships.findIndex(s => s.pixel === pixel);
  const existingDonationIdx = data.sponsorships.findIndex(s => String(s.gw_id) === gwId);

  if (!force) {
    if (existingPixelIdx >= 0)    return j({ error: "pixel_already_claimed",        hint: "pass force:true to overwrite" }, 409);
    if (existingDonationIdx >= 0) return j({ error: "donation_already_attributed", hint: "pass force:true to overwrite" }, 409);
  }

  const orphan      = data.orphan_donations.find(o => String(o.gw_id) === gwId);
  const prior       = existingPixelIdx >= 0 ? data.sponsorships[existingPixelIdx] : null;
  const tier        = body.tier        || prior?.tier        || "standard";
  const donorType   = body.donor_type  || "individual";
  const sponsorName = body.sponsor_name || orphan?.name      || prior?.sponsor || "Anonymous";
  const message     = body.message      || orphan?.message   || prior?.message || "";
  const amount      = parseInt(body.amount, 10) || orphan?.amount || prior?.amount || 0;
  const logo        = body.logo_url    ?? prior?.logo ?? "";

  const entry = {
    pixel,
    sponsor:  sponsorName,
    initials: initialsFor(sponsorName),
    logo,
    logoBg:   donorType === "corporate" ? "#202124"
            : (tier === "premium"  ? "#c5a572"
            : (tier === "featured" ? "#1a73e8"
            : "#f56600")),
    amount,
    tier,
    message,
    gw_id:        gwId,
    confirmed_ms: prior?.confirmed_ms || Date.now(),
    manually_assigned: true,
  };

  if (existingPixelIdx >= 0) {
    data.sponsorships[existingPixelIdx] = entry;
  } else if (existingDonationIdx >= 0) {
    data.sponsorships[existingDonationIdx] = entry;
  } else {
    data.sponsorships.push(entry);
  }

  // Remove from pending and orphans if present.
  data.pending          = data.pending.filter(p => p.pixel !== pixel);
  data.orphan_donations = data.orphan_donations.filter(o => String(o.gw_id) !== gwId);

  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

  return j({ ok: true, pixel, gw_id: gwId, amount, updated: force && (existingPixelIdx >= 0 || existingDonationIdx >= 0) });
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
