/**
 * POST /api/claim
 * --------------------------------------------------------------
 * Reserves a mile for a visitor while they complete their donation
 * on Enthuse. Writes a `pending` row into sponsorships.json (via
 * Cloudflare KV — see `wrangler.toml`) and returns:
 *   { claim_id, enthuse_url }
 *
 * The Enthuse URL has the claim_id + every sponsor field encoded
 * as custom params. Enthuse then forwards them on the donation
 * webhook, which calls /api/enthuse-webhook to confirm the claim.
 *
 * Required env bindings (set in Cloudflare Pages → Settings → Env vars):
 *   ENTHUSE_CAMPAIGN_URL   e.g. https://enthuse.com/p/teatrade-run
 *   SPONSORSHIPS_KV        Cloudflare KV namespace binding
 *   PENDING_TTL_MIN        e.g. "30"
 */
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const {
    pixel,
    tier,           // "standard" | "featured" | "premium"
    amount,         // pence — server enforces the per-tier price
    donor_type,     // "individual" | "corporate"
    sponsor_name,   // display name on the pixel
    message,
    logo_url,       // optional, from Cloudinary upload widget
    contact_email,  // for follow-up if their donation never lands
  } = body || {};

  // Server-side guards — never trust the client.
  const pixelNum = Number(pixel);
  if (!Number.isInteger(pixelNum) || pixelNum < 1 || pixelNum > 190) {
    return json({ error: "bad_pixel" }, 400);
  }
  const expectedAmount = priceForTier(tier);
  if (!expectedAmount || Number(amount) !== expectedAmount) {
    return json({ error: "bad_amount" }, 400);
  }
  if (!sponsor_name || sponsor_name.length > 80) {
    return json({ error: "bad_name" }, 400);
  }
  if (donor_type !== "individual" && donor_type !== "corporate") {
    return json({ error: "bad_donor_type" }, 400);
  }
  if (message && message.length > 200) {
    return json({ error: "message_too_long" }, 400);
  }

  // Reject if the pixel is already claimed or has a fresh pending claim.
  const data = await readSponsorships(env);
  if (data.sponsorships.some(s => s.pixel === pixelNum)) {
    return json({ error: "already_claimed" }, 409);
  }
  const ttlMs = Number(env.PENDING_TTL_MIN || 30) * 60 * 1000;
  const now = Date.now();
  data.pending = (data.pending || []).filter(p => now - p.created_ms < ttlMs);
  if (data.pending.some(p => p.pixel === pixelNum)) {
    return json({ error: "pending" }, 409);
  }

  const claim_id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  data.pending.push({
    claim_id,
    pixel: pixelNum,
    tier,
    amount: expectedAmount,
    donor_type,
    sponsor_name,
    message: message || "",
    logo_url: logo_url || null,
    contact_email: contact_email || null,
    created_ms: now,
  });
  await writeSponsorships(env, data);

  // Hand the donor over to Enthuse with the claim_id baked in.
  // Enthuse echoes custom params back on the webhook payload.
  const url = new URL(env.ENTHUSE_CAMPAIGN_URL);
  url.searchParams.set("amount", String(expectedAmount));
  url.searchParams.set("claim_id", claim_id);
  url.searchParams.set("ref", `mile-${pixelNum}`);
  url.searchParams.set("custom_mile", String(pixelNum));
  url.searchParams.set("custom_tier", tier);
  url.searchParams.set("custom_donor_type", donor_type);

  return json({ claim_id, enthuse_url: url.toString() });
}

function priceForTier(tier) {
  if (tier === "standard")  return 50;
  if (tier === "featured")  return 100;
  if (tier === "premium")   return 250;
  return null;
}

async function readSponsorships(env) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  if (!raw) {
    // Bootstrap from the committed file shape on first run.
    return { sponsorships: [], pending: [], raised_total: 0, raised_goal: 19000 };
  }
  return JSON.parse(raw);
}

async function writeSponsorships(env, data) {
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
