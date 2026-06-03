/**
 * GET /api/sponsorships
 * --------------------------------------------------------------
 * Public read endpoint for the front-end. Also runs the
 * reconciliation sweeper that promotes pending claims to
 * confirmed sponsorships by scraping GiveWheel's PUBLIC
 * fundraising page (the only place where individual donations
 * are actually exposed — the `/api/fundraisings/.../donations/`
 * endpoint returns 500 and is not a real public API).
 *
 * Matching strategy (per pending row, first hit wins):
 *   1. Lock code substring (rarely works — GiveWheel hides custom
 *      question answers on the public page, but kept as a cheap
 *      first check in case that changes).
 *   2. Pending message text + matching amount visible on the page.
 *   3. (Fallback) Amount-only when the pending row has no message
 *      AND exactly one un-credited donation on the page matches
 *      that amount.
 *
 * `confirmed_fingerprints` stops the same visible donation from
 * being credited twice across polls.
 */

const PENDING_TTL_MS  = 30 * 60 * 1000; // 30 mins
const GW_PAGE_URL     = "https://www.givewheel.com/fundraising/16454/run-teatrade/";

export async function onRequestGet({ env }) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  let data = raw ? JSON.parse(raw) : {
    sponsorships: [], pending: [], general_pending: [],
    general_donations: [], confirmed_fingerprints: [],
    raised_total: 0, raised_goal: 19000, updated: null,
  };
  data.sponsorships           = data.sponsorships           || [];
  data.pending                = data.pending                || [];
  data.general_pending        = data.general_pending        || [];
  data.general_donations      = data.general_donations      || [];
  data.confirmed_fingerprints = data.confirmed_fingerprints || [];

  let changed = false;
  const now = Date.now();

  // 1. Drop expired pending rows.
  const beforeP  = data.pending.length;
  const beforeGP = data.general_pending.length;
  data.pending         = data.pending.filter(p =>
    (p.expiresAt || ((p.created_ms || 0) + PENDING_TTL_MS)) > now);
  data.general_pending = data.general_pending.filter(p =>
    ((p.created_ms || 0) + PENDING_TTL_MS) > now);
  if (data.pending.length !== beforeP || data.general_pending.length !== beforeGP) changed = true;

  // 2. Pull the public fundraising page.
  let pageHtml = "";
  let pageText = "";
  let visibleDonations = [];
  let fetchErr = null;
  try {
    const r = await fetch(GW_PAGE_URL, {
      headers: { "user-agent": "TeaTradeRun-Sweeper/1.0 (+https://teatrade.run)" },
      cf: { cacheTtl: 0 },
    });
    if (r.ok) {
      pageHtml = await r.text();
      pageText = stripHtml(pageHtml);
      visibleDonations = parseDonations(pageText);
    } else {
      fetchErr = `gw_http_${r.status}`;
    }
  } catch (e) {
    fetchErr = "gw_fetch_failed";
  }

  const confirmed = new Set(data.confirmed_fingerprints);

  // --- Mile claims ---
  data.pending = data.pending.filter(p => {
    const hit = findMatch(p, pageHtml, pageText, visibleDonations, confirmed);
    if (!hit) return true;
    confirmed.add(hit.fingerprint);
    data.sponsorships.push({
      pixel:        p.pixel,
      sponsor:      p.sponsor_name,
      initials:     initialsFor(p.sponsor_name),
      logo:         p.logo_url || "",
      logoBg:       p.donor_type === "corporate" ? "#202124"
                  : (p.tier === "premium"  ? "#c5a572"
                  : (p.tier === "featured" ? "#1a73e8"
                  : "#f56600")),
      amount:       hit.amount || p.amount,
      tier:         p.tier,
      message:      p.message || "",
      gw_fingerprint: hit.fingerprint,
      confirmed_ms: now,
    });
    data.raised_total = (data.raised_total || 0) + (hit.amount || p.amount || 0);
    changed = true;
    return false;
  });

  // --- Generic donations ---
  data.general_pending = data.general_pending.filter(p => {
    const hit = findMatch(p, pageHtml, pageText, visibleDonations, confirmed);
    if (!hit) return true;
    confirmed.add(hit.fingerprint);
    data.general_donations.push({
      sponsor:      p.sponsor_name,
      donor_type:   p.donor_type,
      amount:       hit.amount || p.amount,
      message:      p.message || "",
      gw_fingerprint: hit.fingerprint,
      confirmed_ms: now,
    });
    data.raised_total = (data.raised_total || 0) + (hit.amount || p.amount || 0);
    changed = true;
    return false;
  });

  data.confirmed_fingerprints = Array.from(confirmed).slice(-500);

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
    // diag block — handy when troubleshooting; safe to expose.
    _diag: {
      gw_fetch_ok:        !fetchErr,
      gw_fetch_err:       fetchErr,
      gw_visible_count:   visibleDonations.length,
      pending_count:      data.pending.length,
      general_pending_count: data.general_pending.length,
    },
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

// --- matching ---------------------------------------------------

function findMatch(pending, html, text, donations, confirmed) {
  const code = pending.code || pending.claim_id;

  // 1. Lock code anywhere in the raw HTML (rare).
  if (code && html && html.includes(code)) {
    const fp = `code:${code}`;
    if (!confirmed.has(fp)) return { amount: pending.amount, fingerprint: fp };
  }

  // 2. Message + amount visible on the page.
  const msg = (pending.message || "").trim();
  if (msg && text) {
    const msgHit = text.includes(msg);
    const amtVisible = visibleAmount(text, pending.amount);
    if (msgHit && amtVisible) {
      const fp = `msg:${normalise(msg)}|amt:${pending.amount}`;
      if (!confirmed.has(fp)) return { amount: pending.amount, fingerprint: fp };
    }
  }

  // 3. Amount-only fallback when there's no message — only if
  // exactly one un-credited donation on the page matches.
  if (!msg) {
    const candidates = donations
      .filter(d => d.amount === pending.amount)
      .map(d => ({ ...d, fingerprint: `amt:${d.amount}|t:${d.tsHint || ""}` }))
      .filter(d => !confirmed.has(d.fingerprint));
    if (candidates.length === 1) return candidates[0];
  }

  return null;
}

function visibleAmount(text, amount) {
  if (!amount) return false;
  // Matches "£50", "£ 50", "£50.00", with optional thousands separators.
  const n = Number(amount);
  const re = new RegExp(`£\\s*${n}(?:\\.00)?\\b`);
  return re.test(text);
}

// --- public-page parsing ----------------------------------------

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&pound;/g, "£")
    .replace(/&#163;/g, "£")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Pull every visible "£NN(.NN)" amount out of the page text. We can't
// reliably bind each to a single donor on the public page, so this
// is only used by the amount-only fallback above.
function parseDonations(text) {
  const out = [];
  const re = /£\s*([\d,]+(?:\.\d{2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const amt = parseFloat(raw);
    if (Number.isFinite(amt) && amt >= 1 && amt <= 100000) {
      out.push({ amount: Math.round(amt), tsHint: String(m.index) });
    }
  }
  return out;
}

function normalise(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function initialsFor(name) {
  return (name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}
