/**
 * POST /api/donate
 * --------------------------------------------------------------
 * "Donate any amount" — a general donation that doesn't claim a mile.
 * Records a pending entry keyed by a g_ code which travels through
 * GiveWheel as d_question_1, so /api/sponsorships can match it on the next
 * poll. Min donation £1.
 */
import {
  PENDING_TTL_MS, PENDING_KEEP_MS, cleanText, checkoutUrl, ensureShape,
} from "../_lib/sponsor.js";
import { cleanEmail } from "../_lib/email.js";

const MAX_GENERAL_PENDING = 500;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }

  const amt = Number(body?.amount);
  if (!Number.isFinite(amt) || amt < 1 || amt > 100000) return json({ error: "bad_amount" }, 400);

  const name = cleanText(body.sponsor_name, 80);
  if (!name) return json({ error: "bad_name" }, 400);

  const donorType = body.donor_type === "corporate" ? "corporate" : "individual";
  if (body.donor_type !== "individual" && body.donor_type !== "corporate") {
    return json({ error: "bad_donor_type" }, 400);
  }

  const message = cleanText(body.message, 200);
  const email   = cleanEmail(body.contact_email);
  if (body.contact_email && !email) return json({ error: "bad_email" }, 400);
  const amount  = Math.round(amt);
  const now     = Date.now();

  const raw  = await env.SPONSORSHIPS_KV.get("data");
  const data = ensureShape(raw ? JSON.parse(raw) : {});

  const claim_id = "g_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  data.general_pending = data.general_pending
    .filter(p => now - (p.created_ms || 0) < PENDING_KEEP_MS)
    .slice(-(MAX_GENERAL_PENDING - 1));
  data.general_pending.push({
    claim_id,
    code:         claim_id,
    amount,
    donor_type:   donorType,
    sponsor_name: name,
    message,
    contact_email:  email || null,
    updates_opt_in: !!email && body.updates_opt_in === true,
    created_ms:   now,
    expiresAt:    now + PENDING_TTL_MS,
  });
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

  // Amount is pre-filled but not locked: donors may change it on GiveWheel.
  return json({
    claim_id,
    GiveWheel_url: checkoutUrl({ amount, lock: false, code: claim_id, name, message }),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
