/**
 * POST /api/givewheel-webhook
 * --------------------------------------------------------------
 * Receives donation events pushed from GiveWheel and attributes
 * them to a mile pixel instantly (no polling, no manual fix).
 *
 * Matching priority:
 *   1. d_question_1 lock code (M{pixel}-XXXX) — deterministic.
 *      Either matches an active pending row, or we recover the
 *      pixel from the code itself if the pending expired.
 *   2. claim_id custom field (alternative path if GiveWheel sends
 *      a separate field rather than re-exposing d_question_1).
 *   3. Name + amount, then message + amount — soft fallbacks for
 *      donations made directly on GiveWheel without our flow.
 *
 * Security:
 *   - If GIVEWHEEL_WEBHOOK_SECRET is set, the request body is
 *     verified against an HMAC-SHA256 signature in one of:
 *       x-givewheel-signature, x-webhook-signature, x-signature
 *     (hex or `sha256=<hex>`). 401 on mismatch.
 *   - If no secret is configured, we accept the request (useful
 *     during initial integration testing) but log a warning.
 *
 * Payload tolerance:
 *   GiveWheel's exact shape isn't documented yet, so we accept
 *   anything that smells like a donation:
 *     { donation: {...} }      or  flat donation fields at top level
 *     { event: "...", data: {...} }
 *   Within the donation object we look in many places for the
 *   amount, donor name, message, and d_question_1 answer.
 */
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();

  // Signature check (optional but recommended).
  if (env.GIVEWHEEL_WEBHOOK_SECRET) {
    const sigHeader =
      request.headers.get("x-givewheel-signature") ||
      request.headers.get("x-webhook-signature")   ||
      request.headers.get("x-signature")           || "";
    const ok = await verifySignature(rawBody, sigHeader, env.GIVEWHEEL_WEBHOOK_SECRET);
    if (!ok) return j({ error: "bad_signature" }, 401);
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return j({ error: "bad_json" }, 400); }

  const donation = extractDonation(payload);
  if (!donation) return j({ error: "no_donation_in_payload", received_keys: Object.keys(payload || {}) }, 400);

  const raw  = await env.SPONSORSHIPS_KV.get("data");
  const data = ensureShape(raw ? JSON.parse(raw) : {});
  const now  = Date.now();

  const gwId = String(donation.id || `wh-${now}-${Math.random().toString(36).slice(2, 8)}`);

  // Idempotency — never attribute the same donation twice.
  if (data.sponsorships.some(s => String(s.gw_id) === gwId)) {
    return j({ ok: true, already_attributed: true, gw_id: gwId });
  }

  // 1. Match against a pending row (preferred — we have logo etc.).
  const pIdx = data.pending.findIndex(p => matchPending(p, donation));
  if (pIdx >= 0) {
    const p = data.pending[pIdx];
    data.sponsorships.push(buildSponsorship(p, donation, gwId, now));
    data.pending.splice(pIdx, 1);
    removeOrphan(data, gwId);
    return await save(env, data, { ok: true, pixel: p.pixel, source: "pending_match" });
  }

  // 2. General "donate any amount" pending.
  const gIdx = data.general_pending.findIndex(p => matchPending(p, donation));
  if (gIdx >= 0) {
    const p = data.general_pending[gIdx];
    data.general_donations.push({
      sponsor:      p.sponsor_name,
      donor_type:   p.donor_type,
      amount:       donation.amount,
      message:      p.message || donation.message || "",
      gw_id:        gwId,
      confirmed_ms: now,
    });
    data.general_pending.splice(gIdx, 1);
    removeOrphan(data, gwId);
    return await save(env, data, { ok: true, source: "general_match" });
  }

  // 3. Recover from the lock code alone (pending expired, but the
  //    code in d_question_1 tells us the pixel).
  const recovered = recoverFromCode(donation, data);
  if (recovered) {
    data.sponsorships.push({ ...recovered, gw_id: gwId, confirmed_ms: now });
    removeOrphan(data, gwId);
    return await save(env, data, { ok: true, pixel: recovered.pixel, source: "code_recovery" });
  }

  // 4. Unmatched — store as orphan so the admin UI can attribute it.
  if (!data.orphan_donations.some(o => String(o.gw_id) === gwId)) {
    data.orphan_donations.push({
      gw_id:   gwId,
      name:    donation.name || "Anonymous",
      message: donation.message || "",
      amount:  donation.amount,
      code:    donation.code || "",
      date:    donation.dateIso || null,
      seen_ms: now,
    });
  }
  return await save(env, data, { ok: true, orphan: true, gw_id: gwId });
}

// Allow a GET so you can quickly sanity-check the endpoint is live.
export async function onRequestGet() {
  return j({ ok: true, expects: "POST" }, 200);
}

// -- payload extraction ------------------------------------------

function extractDonation(payload) {
  const d = payload?.donation || payload?.data?.donation || payload?.data || payload;
  if (!d || typeof d !== "object") return null;

  const amount = Number(
    d.amount ?? d.donationamount ?? d.donation_amount ?? d.value ?? d.total
  );
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    id:      d.id ?? d.donation_id ?? d.donation_identifier ?? null,
    amount:  Math.round(amount),  // assume GW sends £, not pence — adjust if needed
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

  const containers = [d.questions, d.responses, d.answers, d.donor_questions, d.custom_questions, d.custom_fields];
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

// -- matching ----------------------------------------------------

function matchPending(pending, donation) {
  if (!donation || !Number.isFinite(donation.amount)) return false;

  if (pending.code && donation.code &&
      normalise(pending.code) === normalise(donation.code)) {
    return true;
  }

  if (donation.amount !== pending.amount) return false;

  const pName = normalise(pending.sponsor_name);
  const pMsg  = normalise(pending.message);
  const dName = normalise(donation.name);
  const dMsg  = normalise(donation.message);

  if (pName && dName && (pName === dName || dName.includes(pName) || pName.includes(dName))) return true;
  if (pMsg  && dMsg  && (pMsg  === dMsg  || dMsg.includes(pMsg))) return true;

  return false;
}

function recoverFromCode(d, data) {
  const code = (d.code || "").trim();
  if (!code) return null;
  const m = /^M(\d{1,3})-/i.exec(code);
  if (!m) return null;
  const pixel = parseInt(m[1], 10);
  if (!pixel || pixel < 1 || pixel > 190) return null;
  if (data.sponsorships.some(s => s.pixel === pixel)) return null;

  const tier = d.amount >= 250 ? "patron"
             : d.amount >= 100 ? "premium"
             : "standard";
  const sponsor = d.name || "Anonymous";
  return {
    pixel,
    sponsor,
    initials: initialsFor(sponsor),
    logo:     "",
    logoBg:   tier === "patron"  ? "#1a73e8"
            : tier === "premium" ? "#c5a572"
            : "#f56600",
    amount:   d.amount,
    tier,
    message:  d.message || "",
    recovered_from_code: true,
  };
}

function buildSponsorship(p, donation, gwId, now) {
  return {
    pixel:    p.pixel,
    sponsor:  p.sponsor_name,
    initials: initialsFor(p.sponsor_name),
    logo:     p.logo_url || "",
    logoBg:   p.donor_type === "corporate" ? "#202124"
            : (p.tier === "premium"  ? "#c5a572"
            : (p.tier === "featured" ? "#1a73e8"
            : "#f56600")),
    amount:   donation.amount,
    tier:     p.tier,
    message:  p.message || donation.message || "",
    gw_id:    gwId,
    confirmed_ms: now,
  };
}

// -- helpers -----------------------------------------------------

function removeOrphan(data, gwId) {
  data.orphan_donations = data.orphan_donations.filter(o => String(o.gw_id) !== gwId);
}

async function save(env, data, body) {
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
  return j(body, 200);
}

function normalise(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function initialsFor(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}

function ensureShape(data) {
  data.sponsorships      = data.sponsorships      || [];
  data.pending           = data.pending           || [];
  data.general_pending   = data.general_pending   || [];
  data.general_donations = data.general_donations || [];
  data.orphan_donations  = data.orphan_donations  || [];
  data.raised_total      = data.raised_total      || 0;
  data.raised_goal       = data.raised_goal       || 19000;
  return data;
}

function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function verifySignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  // Accept "sha256=<hex>" or just "<hex>".
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
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
