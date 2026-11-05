/**
 * POST /api/givewheel-webhook
 * --------------------------------------------------------------
 * Optional push path for GiveWheel donation events. The authoritative path is
 * the poll in /api/sponsorships; this just makes attribution instant when
 * GiveWheel is configured to call it.
 *
 * Security: the body must carry a valid HMAC-SHA256 signature
 * (x-givewheel-signature / x-webhook-signature / x-signature, hex or
 * `sha256=<hex>`) made with GIVEWHEEL_WEBHOOK_SECRET. With no secret
 * configured the endpoint is disabled — an unsigned request could otherwise
 * lock any mile without a payment.
 *
 * Attribution uses the same rules as the poll (see _lib/sponsor.js).
 */
import { ensureShape, reconcileAll, persistLogo } from "../_lib/sponsor.js";

export async function onRequestPost({ request, env }) {
  if (!env.GIVEWHEEL_WEBHOOK_SECRET) return j({ error: "webhook_disabled" }, 503);

  const rawBody = await request.text();
  const sigHeader =
    request.headers.get("x-givewheel-signature") ||
    request.headers.get("x-webhook-signature")   ||
    request.headers.get("x-signature")           || "";
  if (!(await verifySignature(rawBody, sigHeader, env.GIVEWHEEL_WEBHOOK_SECRET))) {
    return j({ error: "bad_signature" }, 401);
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return j({ error: "bad_json" }, 400); }

  const donation = extractDonation(payload);
  if (!donation) return j({ error: "no_donation_in_payload", received_keys: Object.keys(payload || {}) }, 400);

  const raw  = await env.SPONSORSHIPS_KV.get("data");
  const data = ensureShape(raw ? JSON.parse(raw) : {});
  const now  = Date.now();

  const { changed, outcomes } = reconcileAll(data, [donation], now);
  const outcome = outcomes[0] || { kind: "already_attributed" };

  if (changed) {
    if (outcome.kind === "pending_match") {
      const s = data.sponsorships.find(x => x.pixel === outcome.pixel);
      try { await persistLogo(env, s?.logo); } catch { /* logo stays under its TTL */ }
    }
    data.updated = new Date().toISOString();
    await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
  }
  return j({ ok: true, gw_id: String(donation.id), ...outcome }, 200);
}

export async function onRequestGet() {
  return j({ ok: true, expects: "POST" }, 200);
}

// -- payload extraction ------------------------------------------

function extractDonation(payload) {
  const d = payload?.donation || payload?.data?.donation || payload?.data || payload;
  if (!d || typeof d !== "object") return null;

  const amount = Number(d.amount ?? d.donationamount ?? d.donation_amount ?? d.value ?? d.total);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const id = d.id ?? d.donation_id ?? d.donation_identifier;
  if (id == null || id === "") return null;   // can't dedupe without an id

  return {
    id,
    amount:  Math.round(amount),   // assumes £, not pence
    name:    extractQuestion(d, 2) || d.Name || d.name || d.donor_name || d.display_name || "",
    message: extractQuestion(d, 3) || d.Message || d.message || d.comment || "",
    code:    extractQuestion(d, 1) || d.claim_id || d.custom_fields?.claim_id || "",
    dateIso: d.transaction_date || d.created_at || d.date || null,
  };
}

function extractQuestion(d, n) {
  const flat = [
    `d_question_${n}`, `question_${n}`, `q${n}`,
    `Question${n}`, `question${n}`, `custom_${n}`, `custom_field_${n}`,
  ];
  for (const k of flat) if (d[k] != null && d[k] !== "") return String(d[k]);

  const containers = [d.supporter_questions, d.questions, d.responses, d.answers, d.donor_questions, d.custom_questions, d.custom_fields];
  for (const c of containers) {
    if (!c) continue;
    if (Array.isArray(c)) {
      const entry = c[n - 1] || c.find(x => x && (x.id === n || x.number === n || x.position === n));
      if (entry) {
        const v = entry.answer ?? entry.value ?? entry.response ?? entry.text;
        if (v != null && v !== "") return String(v);
      }
    } else if (typeof c === "object") {
      const v = c[n] ?? c[String(n)] ?? c[`question_${n}`] ?? c[`d_question_${n}`];
      if (v != null && v !== "") return String(v);
    }
  }
  return "";
}

function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function verifySignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
