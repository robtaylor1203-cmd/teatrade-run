/**
 * Shared server-side rules for sponsoring a mile. Used by claim, the
 * /api/sponsorships poll, the GiveWheel webhook and the admin endpoint so
 * pricing, tiers, matching and sanitising can never drift apart.
 *
 * Prices/tiers must mirror CONFIG in index.html (premium 1 & 190 = £250,
 * every 10th mile up to 180 = £100, everything else = £50).
 */

export const MILE_COUNT      = 190;
export const PENDING_TTL_MS  = 30 * 60 * 1000;        // how long a mile stays locked in checkout
export const PENDING_KEEP_MS = 48 * 60 * 60 * 1000;   // how long we remember a claim so late payers still get their logo/message
export const GW_CHECKOUT_BASE = "https://www.givewheel.com/fundraising/16454/run-teatrade/";

const PRICES = { premium: 250, featured: 100, standard: 50 };

export function mileTier(pixel) {
  if (pixel === 1 || pixel === MILE_COUNT) return "premium";
  if (pixel % 10 === 0) return "featured";
  return "standard";
}

export function milePrice(pixel) {
  return PRICES[mileTier(pixel)];
}

export function sponsorColour(donorType, tier) {
  return donorType === "corporate" ? "#202124"
       : tier === "premium"        ? "#c5a572"
       : tier === "featured"       ? "#1a73e8"
       : "#f56600";
}

export function initialsFor(name) {
  return (name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}

export function normalise(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

// Strips control characters and collapses whitespace. HTML escaping is done
// at render time; this just keeps stored values tidy and bounded.
export function cleanText(v, max) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const LOGO_LOCAL    = /^\/api\/logo\/[A-Za-z0-9_-]{6,40}$/;
export const LOGO_MAX_CHARS = 500_000;

// Returns a safe logo value or "". Public claims may only send a data URL;
// admins may also use an https URL or one of our own /api/logo/ paths.
export function cleanLogo(v, { allowHttps = false } = {}) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length <= LOGO_MAX_CHARS && LOGO_DATA_URL.test(s)) return s;
  if (!allowHttps) return "";
  if (LOGO_LOCAL.test(s)) return s;
  if (s.length <= 500 && /^https:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
  return "";
}

// Logos of unpaid claims expire with the claim; once paid, make the logo permanent.
export const LOGO_TTL_SEC = 3 * 24 * 60 * 60;

export async function persistLogo(env, logoPath) {
  const m = /^\/api\/logo\/([A-Za-z0-9_-]+)$/.exec(logoPath || "");
  if (!m) return;
  const stored = await env.SPONSORSHIPS_KV.get(`logo:${m[1]}`);
  if (stored) await env.SPONSORSHIPS_KV.put(`logo:${m[1]}`, stored);
}

export function safeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomId(len = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => (b % 36).toString(36)).join("").toUpperCase();
}

// GiveWheel checkout link. `lock` stops the donor changing a mile's price.
// Questions: 1 = lock code, 2 = name, 3 = message.
export function checkoutUrl({ amount, lock, code, name, message }) {
  const q = [
    "checkout=true",
    `donation=${amount}`,
    lock ? "lock_amount=true" : null,
    `d_question_1=${encodeURIComponent(code)}`,
    `d_question_2=${encodeURIComponent(name || "Anonymous")}`,
    `d_question_3=${encodeURIComponent(message || "")}`,
  ].filter(Boolean).join("&");
  return `${GW_CHECKOUT_BASE}?${q}`;
}

export function ensureShape(data) {
  data = data || {};
  data.sponsorships      = data.sponsorships      || [];
  data.pending           = data.pending           || [];
  data.general_pending   = data.general_pending   || [];
  data.general_donations = data.general_donations || [];
  data.orphan_donations  = data.orphan_donations  || [];
  data.raised_total      = data.raised_total      || 0;
  data.raised_goal       = data.raised_goal       || 19000;
  return data;
}

export function isActive(p, now) {
  return (p.expiresAt || ((p.created_ms || 0) + PENDING_TTL_MS)) > now;
}

export function parseLockCode(code) {
  const m = /^M(\d{1,3})-/i.exec(String(code || "").trim());
  if (!m) return null;
  const pixel = parseInt(m[1], 10);
  return pixel >= 1 && pixel <= MILE_COUNT ? pixel : null;
}

function isOurCode(code) {
  return parseLockCode(code) !== null || /^g_[0-9a-f]+$/i.test(String(code || "").trim());
}

// Does this GiveWheel donation belong to this pending claim?
//  - A donation carrying one of OUR lock codes can only match the claim with
//    that exact code (even if the claim has since expired).
//  - Otherwise fall back to amount + name/message against live claims only.
// Mile claims also need the donation to cover the mile's price.
export function matchesPending(p, d, now) {
  if (!d || !Number.isFinite(d.amount)) return false;

  const pCode = normalise(p.code || p.claim_id);
  const dCode = normalise(d.code);

  if (isOurCode(d.code)) {
    return !!pCode && pCode === dCode && (!p.pixel || d.amount >= p.amount);
  }

  if (!isActive(p, now)) return false;
  if (d.amount !== p.amount) return false;
  if (d.ts && p.created_ms && d.ts < p.created_ms - 5 * 60 * 1000) return false;

  const pName = normalise(p.sponsor_name), dName = normalise(d.name);
  const pMsg  = normalise(p.message),      dMsg  = normalise(d.message);
  if (pName && dName && (pName === dName || dName.includes(pName) || pName.includes(dName))) return true;
  if (pMsg  && dMsg  && (pMsg  === dMsg  || dMsg.includes(pMsg))) return true;
  return false;
}

function sponsorshipFromPending(p, d, gwId, now) {
  const tier = mileTier(p.pixel);
  const donorType = p.donor_type === "corporate" ? "corporate" : "individual";
  return {
    pixel:      p.pixel,
    sponsor:    p.sponsor_name,
    initials:   initialsFor(p.sponsor_name),
    logo:       p.logo_url || "",
    logoBg:     sponsorColour(donorType, tier),
    donor_type: donorType,
    amount:     d.amount,
    tier,
    message:    p.message || cleanText(d.message, 200),
    gw_id:      gwId,
    confirmed_ms: now,
  };
}

// A paid donation carrying a lock code whose claim we no longer hold: rebuild
// the sponsorship from the donation itself. Only if the mile is free and the
// donation actually covers its price.
function sponsorshipFromCode(d, gwId, data, now) {
  const pixel = parseLockCode(d.code);
  if (!pixel) return null;
  if (data.sponsorships.some(s => s.pixel === pixel)) return null;
  if (d.amount < milePrice(pixel)) return null;

  const tier = mileTier(pixel);
  const sponsor = cleanText(d.name, 80) || "Anonymous";
  return {
    pixel,
    sponsor,
    initials:   initialsFor(sponsor),
    logo:       "",
    logoBg:     sponsorColour("individual", tier),
    donor_type: "individual",
    amount:     d.amount,
    tier,
    message:    cleanText(d.message, 200),
    gw_id:      gwId,
    confirmed_ms: now,
    recovered_from_code: true,
  };
}

// An admin-assigned placeholder (gw_id "manual-*") holds the mile; attach the
// real donation id to it instead of orphaning the donation.
function upgradeManualEntry(data, pixel, gwId, now) {
  const entry = data.sponsorships.find(s =>
    s.pixel === pixel && /^manual-/i.test(String(s.gw_id || "")));
  if (!entry) return false;
  entry.gw_id       = gwId;
  entry.upgraded_ms = now;
  return true;
}

// Attribute GiveWheel donations to miles. Mutates `data`; returns whether
// anything changed plus the outcome per newly seen donation.
export function reconcileAll(data, donations, now) {
  const handled = new Set([
    ...data.sponsorships.map(s => String(s.gw_id || "")),
    ...data.general_donations.map(g => String(g.gw_id || "")),
  ].filter(Boolean));
  const orphanIds = new Set(data.orphan_donations.map(o => String(o.gw_id)));

  let changed = false;
  const outcomes = [];

  for (const d of donations) {
    const gwId = String(d.id);
    if (handled.has(gwId)) continue;

    const result = attribute(data, d, gwId, now);
    outcomes.push({ gw_id: gwId, ...result });

    if (result.kind === "orphan") {
      if (!orphanIds.has(gwId)) {
        data.orphan_donations.push({
          gw_id:   gwId,
          name:    cleanText(d.name, 80) || "Anonymous",
          message: cleanText(d.message, 200),
          amount:  d.amount,
          code:    d.code || "",
          reason:  result.reason,
          date:    d.dateIso || null,
          seen_ms: now,
        });
        orphanIds.add(gwId);
        changed = true;
      }
    } else {
      handled.add(gwId);
      changed = true;
    }
  }

  // Anything now attributed no longer belongs on the orphan list.
  const before = data.orphan_donations.length;
  data.orphan_donations = data.orphan_donations.filter(o => !handled.has(String(o.gw_id)));
  if (data.orphan_donations.length !== before) changed = true;
  if (data.orphan_donations.length > 200) data.orphan_donations = data.orphan_donations.slice(-200);

  return { changed, outcomes };
}

function attribute(data, d, gwId, now) {
  // 1. A mile claim.
  const pIdx = data.pending.findIndex(p => matchesPending(p, d, now));
  if (pIdx >= 0) {
    const p = data.pending[pIdx];
    const holder = data.sponsorships.find(s => s.pixel === p.pixel);
    if (!holder) {
      data.sponsorships.push(sponsorshipFromPending(p, d, gwId, now));
      data.pending.splice(pIdx, 1);
      return { kind: "pending_match", pixel: p.pixel };
    }
    if (/^manual-/i.test(String(holder.gw_id || ""))) {
      holder.gw_id = gwId;
      holder.upgraded_ms = now;
      data.pending.splice(pIdx, 1);
      return { kind: "manual_upgrade", pixel: p.pixel };
    }
    // Someone else already holds this mile (e.g. a lock expired and a second
    // donor paid first). Keep the money, flag for the admin to sort out.
    return { kind: "orphan", reason: "pixel_taken" };
  }

  // 2. A "donate any amount" claim.
  const gIdx = data.general_pending.findIndex(p => matchesPending(p, d, now));
  if (gIdx >= 0) {
    const p = data.general_pending[gIdx];
    data.general_donations.push({
      sponsor:      p.sponsor_name,
      donor_type:   p.donor_type,
      amount:       d.amount,
      message:      p.message || cleanText(d.message, 200),
      gw_id:        gwId,
      confirmed_ms: now,
    });
    data.general_pending.splice(gIdx, 1);
    return { kind: "general_match" };
  }

  // 3. Claim forgotten but the lock code survived on the donation.
  const recovered = sponsorshipFromCode(d, gwId, data, now);
  if (recovered) {
    data.sponsorships.push(recovered);
    return { kind: "code_recovery", pixel: recovered.pixel };
  }

  // 4. Lock code points at a mile held by a manual placeholder.
  const codePixel = parseLockCode(d.code);
  if (codePixel && d.amount >= milePrice(codePixel) && upgradeManualEntry(data, codePixel, gwId, now)) {
    return { kind: "manual_upgrade", pixel: codePixel };
  }

  return { kind: "orphan", reason: codePixel ? "code_unusable" : "no_code" };
}
