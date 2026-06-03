/**
 * GET /api/sponsorships
 * --------------------------------------------------------------
 * Public read endpoint for the front-end. Also runs the
 * reconciliation sweeper that promotes pending claims to confirmed
 * sponsorships when a matching donation appears in GiveWheel's
 * public donations feed.
 *
 * Matching strategy (per pending row):
 *   1. Unique lock code substring (e.g. "M63-AB12" or "g_abcd1234")
 *      anywhere in the GiveWheel JSON. Most reliable when GiveWheel
 *      echoes the custom question answer.
 *   2. Fallback: structured walk of the feed for a donation with
 *      matching donor name (case-insensitive, trimmed) AND amount
 *      AND arrival time after the claim was created. Rescues claims
 *      when GiveWheel strips custom question answers from the feed.
 *
 * A confirmed_gw_ids set prevents the same GiveWheel donation from
 * being credited twice across polls.
 */

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 mins
const GW_DONATIONS_URL = "https://www.givewheel.com/api/fundraisings/16454/donations/";

export async function onRequestGet({ env }) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  let data = raw ? JSON.parse(raw) : {
    sponsorships: [], pending: [], general_pending: [],
    general_donations: [], confirmed_gw_ids: [],
    raised_total: 0, raised_goal: 19000, updated: null,
  };
  data.sponsorships      = data.sponsorships      || [];
  data.pending           = data.pending           || [];
  data.general_pending   = data.general_pending   || [];
  data.general_donations = data.general_donations || [];
  data.confirmed_gw_ids  = data.confirmed_gw_ids  || [];

  let changed = false;

  // 1. Drop expired pending rows.
  const now = Date.now();
  const beforeP  = data.pending.length;
  const beforeGP = data.general_pending.length;
  data.pending         = data.pending.filter(p => (p.expiresAt || (p.created_ms + PENDING_TTL_MS)) > now);
  data.general_pending = data.general_pending.filter(p => (p.created_ms + PENDING_TTL_MS) > now);
  if (data.pending.length !== beforeP || data.general_pending.length !== beforeGP) changed = true;

  // 2. Poll GiveWheel and try to reconcile.
  let donations = [];
  let gwString  = "";
  try {
    const gwRes = await fetch(GW_DONATIONS_URL, { cf: { cacheTtl: 0 } });
    if (gwRes.ok) {
      const gwData = await gwRes.json();
      gwString  = JSON.stringify(gwData);
      donations = extractDonations(gwData);
    }
  } catch {
    // GiveWheel unreachable — return whatever we already have.
  }

  const confirmedIds = new Set(data.confirmed_gw_ids);

  // --- Mile claims ---
  data.pending = data.pending.filter(p => {
    const match = findMatch(p, gwString, donations, confirmedIds);
    if (!match) return true;
    confirmedIds.add(match.id);
    data.sponsorships.push({
      pixel:        p.pixel,
      sponsor:      p.sponsor_name,
      initials:     initialsFor(p.sponsor_name),
      logo:         p.logo_url || "",
      logoBg:       p.donor_type === "corporate" ? "#202124"
                  : (p.tier === "premium"  ? "#c5a572"
                  : (p.tier === "featured" ? "#1a73e8"
                  : "#f56600")),
      amount:       match.amount || p.amount,
      tier:         p.tier,
      message:      p.message || "",
      gw_id:        match.id,
      confirmed_ms: now,
    });
    data.raised_total = (data.raised_total || 0) + (match.amount || p.amount || 0);
    changed = true;
    return false;
  });

  // --- Generic donations ---
  data.general_pending = data.general_pending.filter(p => {
    const match = findMatch(p, gwString, donations, confirmedIds);
    if (!match) return true;
    confirmedIds.add(match.id);
    data.general_donations.push({
      sponsor:      p.sponsor_name,
      donor_type:   p.donor_type,
      amount:       match.amount || p.amount,
      message:      p.message || "",
      gw_id:        match.id,
      confirmed_ms: now,
    });
    data.raised_total = (data.raised_total || 0) + (match.amount || p.amount || 0);
    changed = true;
    return false;
  });

  data.confirmed_gw_ids = Array.from(confirmedIds).slice(-500); // bounded

  if (changed) {
    data.updated = new Date().toISOString();
    await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
  }

  return new Response(JSON.stringify({
    updated:      data.updated,
    raised_total: data.raised_total || 0,
    raised_goal:  data.raised_goal  || 19000,
    sponsorships: data.sponsorships.map(s => ({
      pixel:    s.pixel,
      sponsor:  s.sponsor,
      initials: s.initials,
      logo:     s.logo,
      logoBg:   s.logoBg,
      amount:   s.amount,
      tier:     s.tier,
      message:  s.message,
    })),
    pending_pixels: data.pending.map(p => p.pixel),
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15",
      "access-control-allow-origin": "*",
    },
  });
}

// --- helpers ----------------------------------------------------

function findMatch(pending, gwString, donations, confirmedIds) {
  // 1. Code substring match (most reliable when GW echoes the answer).
  const code = pending.code || pending.claim_id;
  if (code && gwString && gwString.includes(code)) {
    const exact = donations.find(d => !confirmedIds.has(d.id) && d.raw.includes(code));
    if (exact) return exact;
    // Code is in the blob but we can't pin it to a row — still credit
    // by amount as a best-effort and synthesise an id.
    const byAmt = donations.find(d => !confirmedIds.has(d.id) && d.amount === pending.amount);
    if (byAmt) return byAmt;
    return { id: `code:${code}`, amount: pending.amount, raw: code };
  }

  // 2. Structured fallback: name + amount + arrived-after-claim.
  const wanted = normaliseName(pending.sponsor_name);
  const claimMs = pending.created_ms || (pending.expiresAt ? pending.expiresAt - PENDING_TTL_MS : 0);
  const candidate = donations.find(d =>
    !confirmedIds.has(d.id) &&
    d.amount === pending.amount &&
    normaliseName(d.name) === wanted &&
    (!d.ts || d.ts >= claimMs - 60_000)
  );
  return candidate || null;
}

function normaliseName(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function initialsFor(name) {
  return (name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}

// Try to find a list of donation objects in arbitrary GiveWheel JSON.
function extractDonations(node, out) {
  out = out || [];
  if (Array.isArray(node)) {
    for (const item of node) extractDonations(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (looksLikeDonation(node)) out.push(normaliseDonation(node));
    for (const k of Object.keys(node)) extractDonations(node[k], out);
  }
  return out;
}

function looksLikeDonation(o) {
  const hasAmount = "amount" in o || "amount_pence" in o || "amount_pounds" in o || "value" in o || "total" in o;
  const hasName   = "donor_name" in o || "name" in o || "full_name" in o || "donor" in o || "display_name" in o;
  const hasId     = "id" in o || "uuid" in o || "donation_id" in o || "reference" in o;
  return hasAmount && (hasName || hasId);
}

function normaliseDonation(o) {
  let amount = o.amount ?? o.amount_pounds ?? o.value ?? o.total ?? o.amount_pence;
  if (typeof amount === "string") amount = parseFloat(amount);
  // Heuristic: amounts > 1000 are likely pence (GiveWheel often sends pence).
  if (Number.isFinite(amount) && amount >= 1000 && Number.isInteger(amount)) amount = Math.round(amount / 100);

  const name = o.donor_name || o.full_name || o.display_name || o.name
            || (typeof o.donor === "string" ? o.donor : o.donor?.name)
            || "";

  const id = String(o.id ?? o.uuid ?? o.donation_id ?? o.reference ?? `${name}|${amount}|${o.created_at || o.created || ""}`);

  const tsRaw = o.created_at || o.created || o.completed_at || o.timestamp;
  const ts = tsRaw ? Date.parse(tsRaw) || 0 : 0;

  return { id, name, amount, ts, raw: JSON.stringify(o) };
}
