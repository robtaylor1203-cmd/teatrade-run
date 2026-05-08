/**
 * POST /api/enthuse-webhook
 * --------------------------------------------------------------
 * Called by Enthuse when a donation completes successfully.
 * We:
 *   1. Verify the HMAC signature (header `x-enthuse-signature`).
 *   2. Find the matching `pending` row by claim_id.
 *   3. Move it to `sponsorships`, applying donor_type → tier mapping
 *      so the pixel renders in the right colour.
 *   4. Increment raised_total.
 *   5. Persist back to KV — the public site reads this on every load.
 *
 * Required env bindings:
 *   ENTHUSE_WEBHOOK_SECRET    HMAC shared secret from Enthuse
 *   SPONSORSHIPS_KV           Cloudflare KV namespace binding
 *
 * Webhook payload shape (per Enthuse partner docs — verify with
 * your Enthuse contact, fields may need renaming below):
 *   {
 *     "event": "donation.completed",
 *     "donation": {
 *       "id":     "ent-12345",
 *       "amount": 5000,                 // pence
 *       "currency": "GBP",
 *       "donor_name": "Welsh Tea Co.",
 *       "message":   "Cymru am byth!",
 *       "custom_fields": {
 *         "claim_id":   "abc123",
 *         "mile":       "47",
 *         "tier":       "standard",
 *         "donor_type": "corporate"
 *       }
 *     }
 *   }
 */
export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const sig = request.headers.get("x-enthuse-signature") || "";
  const ok = await verifySignature(raw, sig, env.ENTHUSE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 401 });

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return new Response("bad json", { status: 400 }); }

  if (payload.event !== "donation.completed") {
    return new Response("ignored", { status: 200 });
  }

  const d = payload.donation || {};
  const claimId = d.custom_fields?.claim_id;
  if (!claimId) return new Response("missing claim_id", { status: 400 });

  const data = await readSponsorships(env);

  // "Donate any amount" claims are prefixed with `g_` and live in
  // `general_pending`. They credit raised_total + record a public
  // entry, but do not touch any pixel.
  if (claimId.startsWith("g_")) {
    const gIdx = (data.general_pending || []).findIndex(p => p.claim_id === claimId);
    const gClaim = gIdx >= 0 ? data.general_pending[gIdx] : null;
    if (gIdx >= 0) data.general_pending.splice(gIdx, 1);

    data.general_donations = data.general_donations || [];
    data.general_donations.push({
      sponsor:    gClaim?.sponsor_name || d.donor_name || "Anonymous",
      donor_type: gClaim?.donor_type || "individual",
      amount:     Math.round((d.amount || (gClaim?.amount || 0) * 100) / 100),
      message:    gClaim?.message || d.message || "",
      enthuse_id: d.id,
      confirmed_ms: Date.now(),
    });
    data.raised_total = (data.raised_total || 0) + Math.round((d.amount || 0) / 100);
    await writeSponsorships(env, data);
    return new Response("ok-general", { status: 200 });
  }

  const idx = (data.pending || []).findIndex(p => p.claim_id === claimId);
  if (idx === -1) {
    // Donation arrived without a pending claim — log it, but still
    // credit the total raised so the headline number stays accurate.
    data.raised_total = (data.raised_total || 0) + Math.round((d.amount || 0) / 100);
    data.orphan_donations = (data.orphan_donations || []);
    data.orphan_donations.push({ id: d.id, amount: d.amount, ts: Date.now() });
    await writeSponsorships(env, data);
    return new Response("orphaned", { status: 200 });
  }

  const claim = data.pending[idx];
  data.pending.splice(idx, 1);

  data.sponsorships.push({
    pixel:     claim.pixel,
    sponsor:   claim.sponsor_name,
    initials:  initialsFor(claim.sponsor_name),
    logo:      claim.logo_url || null,
    logoBg:    claim.donor_type === "corporate" ? "#202124" : "#f56600",
    amount:    Math.round((d.amount || claim.amount * 100) / 100),
    // donor_type → tier mapping drives pixel colour:
    //   corporate → black "tier-corporate"
    //   individual at premium price → gold "tier-premium"
    //   everything else → orange (default "standard")
    tier:      claim.donor_type === "corporate"
                 ? "corporate"
                 : (claim.tier === "premium" ? "premium" : "standard"),
    message:   claim.message || d.message || "",
    enthuse_id: d.id,
    confirmed_ms: Date.now(),
  });

  data.raised_total = (data.raised_total || 0) + Math.round((d.amount || 0) / 100);
  await writeSponsorships(env, data);

  return new Response("ok", { status: 200 });
}

function initialsFor(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join("");
}

async function readSponsorships(env) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  if (!raw) return { sponsorships: [], pending: [], raised_total: 0, raised_goal: 19000 };
  return JSON.parse(raw);
}

async function writeSponsorships(env, data) {
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
}

async function verifySignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish compare.
  return expected.length === sigHeader.length &&
         expected.split("").every((c, i) => c === sigHeader[i]);
}
