/**
 * POST /api/claim
 * --------------------------------------------------------------
 * Reserves a mile for 30 minutes and returns the GiveWheel checkout URL.
 * Everything that matters (price, tier, colour) is decided here from the
 * mile number, never trusted from the browser.
 */
import {
  MILE_COUNT, PENDING_TTL_MS, PENDING_KEEP_MS,
  mileTier, milePrice, cleanText, cleanLogo, randomId, checkoutUrl,
  ensureShape, isActive, LOGO_TTL_SEC,
} from "../_lib/sponsor.js";

// Active (unpaid) claims one network address may hold at once.
const MAX_ACTIVE_PER_CLIENT = 5;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }

  const pixel = Number.parseInt(body?.pixel, 10);
  if (!Number.isInteger(pixel) || pixel < 1 || pixel > MILE_COUNT) {
    return json({ error: "invalid_pixel" }, 400);
  }

  const price = milePrice(pixel);
  if (body.amount != null && Number(body.amount) !== price) {
    return json({ error: "bad_amount", expected: price }, 400);
  }

  const donorType = body.donor_type === "corporate" ? "corporate" : "individual";
  const name      = cleanText(body.sponsor_name, 80);
  const message   = cleanText(body.message, 200);
  if (!name) return json({ error: "bad_name" }, 400);

  let logoDataUrl = "";
  if (donorType === "corporate" && body.logo_url) {
    logoDataUrl = cleanLogo(body.logo_url);
    if (!logoDataUrl) return json({ error: "bad_logo" }, 400);
  }

  const clientToken = /^[A-Za-z0-9_-]{8,64}$/.test(body.client_token || "") ? body.client_token : null;
  const ipHash      = await hashIp(request);
  const now         = Date.now();

  const raw  = await env.SPONSORSHIPS_KV.get("data");
  const data = ensureShape(raw ? JSON.parse(raw) : {});
  data.pending = data.pending.filter(p => now - (p.created_ms || 0) < PENDING_KEEP_MS);

  if (data.sponsorships.some(s => s.pixel === pixel)) {
    return json({ error: "already_claimed" }, 409);
  }

  // A donor who bounced back from checkout may retry their own mile. Their
  // old claim is expired rather than deleted so a late payment still lands.
  const lock = data.pending.find(p => p.pixel === pixel && isActive(p, now));
  if (lock) {
    if (!clientToken || lock.client_token !== clientToken) {
      return json({ error: "pending" }, 409);
    }
    lock.expiresAt = now;
  }

  if (ipHash) {
    const held = data.pending.filter(p => p.ip_hash === ipHash && isActive(p, now)).length;
    if (held >= MAX_ACTIVE_PER_CLIENT) return json({ error: "too_many" }, 429);
  }

  const code = `M${pixel}-${randomId(4)}`;

  // Logos live under their own key (served by /api/logo/<code>) so the shared
  // sponsorship document stays small and logos can be cached by browsers.
  let logoPath = null;
  if (logoDataUrl) {
    await env.SPONSORSHIPS_KV.put(`logo:${code}`, logoDataUrl, { expirationTtl: LOGO_TTL_SEC });
    logoPath = `/api/logo/${code}`;
  }

  data.pending.push({
    pixel,
    code,
    claim_id:     code,
    created_ms:   now,
    expiresAt:    now + PENDING_TTL_MS,
    sponsor_name: name,
    donor_type:   donorType,
    message,
    tier:         mileTier(pixel),
    amount:       price,
    logo_url:     logoPath,
    client_token: clientToken,
    ip_hash:      ipHash,
  });
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

  return json({
    GiveWheel_url: checkoutUrl({ amount: price, lock: true, code, name, message }),
    code,
  });
}

async function hashIp(request) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("teatrade-run:" + ip));
  return Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
