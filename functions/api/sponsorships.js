/**
 * GET /api/sponsorships
 * --------------------------------------------------------------
 * Public read endpoint. Also drives reconciliation between
 * GiveWheel and our KV store.
 *
 * Architecture (the only one that's actually reliable):
 *   1. raised_total is DERIVED from GiveWheel's authenticated
 *      donations API on every poll. That's the source of truth.
 *   2. Pixel reconciliation is best-effort layered on top: when a
 *      GW donation's Name+amount (or Message+amount) matches a
 *      pending claim, promote it to a confirmed sponsorship.
 *      Dedupe by the GW donation id.
 *   3. Orphan donations (no matching pending) still credit the
 *      total and are kept in an `orphan_donations` list so they
 *      can be manually attributed via /api/admin/assign-pixel.
 *
 * Required env vars (set in Cloudflare Pages):
 *   GIVEWHEEL_API_TOKEN       Knox bearer token for the fundraiser
 *                             owner. Obtain via POST /api/auth/login/.
 *   GIVEWHEEL_FUNDRAISING_ID  Defaults to 16454.
 */

const PENDING_TTL_MS = 30 * 60 * 1000;

export async function onRequestGet({ env }) {
  const fundraisingId = env.GIVEWHEEL_FUNDRAISING_ID || "16454";
  const token         = env.GIVEWHEEL_API_TOKEN;

  const raw = await env.SPONSORSHIPS_KV.get("data");
  let data = raw ? JSON.parse(raw) : freshState();
  data = ensureShape(data);

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

  // 2. Pull authoritative data from GiveWheel.
  //
  // Two-tier strategy:
  //   (a) Always hit /api/fundraisings/url/ — works without auth,
  //       returns total_raised and supporter count. This is the
  //       headline-number source of truth.
  //   (b) Also try /api/fundraisings/{id}/donations/ with a Knox
  //       Token for per-donation detail (needed to match pixels by
  //       d_question_1 lock code). If this fails we still have (a)
  //       so the totals are correct; matching just degrades to
  //       pending-row-only.
  let donations    = [];
  let fetchErr     = null;
  let donationsOk  = false;
  let summaryTotal = null;
  let summarySupporters = null;
  let rawSample    = null;
  const attempts   = [];

  // (a) Public summary — no auth required. The endpoint matches on
  //     an exact donor-facing URL, so we try a few known forms: the
  //     gvwhl.com shortlink (confirmed working), then the slugged
  //     fundraising URL, then the bare id URL.
  const shortlink   = env.GIVEWHEEL_SHORTLINK || "https://gvwhl.com/ORSR6";
  const slug        = env.GIVEWHEEL_SLUG      || "run-teatrade";
  const summaryUrls = [
    shortlink,
    `https://www.givewheel.com/fundraising/${fundraisingId}/${slug}/`,
    `https://www.givewheel.com/fundraising/${fundraisingId}/`,
  ];
  for (const candidate of summaryUrls) {
    try {
      const summaryUrl = `https://www.givewheel.com/api/fundraisings/url/?url=${encodeURIComponent(candidate)}`;
      const r = await fetch(summaryUrl, {
        headers: {
          "accept":     "application/json",
          "user-agent": "teatrade-run-reconciler/1.0",
        },
        cf: { cacheTtl: 0 },
      });
      const txt = await r.text();
      attempts.push({ what: "summary", url: candidate, status: r.status, snippet: txt.slice(0, 160) });
      if (r.ok) {
        const j = JSON.parse(txt);
        summaryTotal      = Number(j.amount_raised) || Number(j.total_raised) || 0;
        summarySupporters = Number(j.supporters) || 0;
        fetchErr = null;
        break;
      }
      fetchErr = `summary_http_${r.status}`;
    } catch (e) {
      attempts.push({ what: "summary", url: candidate, error: String(e && e.message || e) });
      fetchErr = "summary_failed";
    }
  }

  // (b) Per-donation list — needs a Knox token. The OpenAPI schema
  //     documents /api/fundraisings/{id}/donations/ but that path
  //     currently 404s. Try a handful of plausible variants so that
  //     if GiveWheel exposes the data under any of them we'll pick
  //     it up automatically. Each attempt is logged in _diag for
  //     post-mortem inspection.
  if (token) {
    const candidates = [
      `https://www.givewheel.com/api/fundraisings/${fundraisingId}/donations/`,
      `https://www.givewheel.com/api/fundraisings/${fundraisingId}/donations`,
      `https://www.givewheel.com/api/donations/?fundraising=${fundraisingId}`,
      `https://www.givewheel.com/api/donations/?fundraising_id=${fundraisingId}`,
      `https://www.givewheel.com/api/donations/?fundraisings=${fundraisingId}`,
      `https://www.givewheel.com/api/fundraisings/${fundraisingId}/donations/list/`,
      `https://www.givewheel.com/api/fundraisings/${fundraisingId}/donation_list/`,
      `https://www.givewheel.com/api/fundraisings/${fundraisingId}/supporters/`,
    ];
    outer:
    for (const donationsUrl of candidates) {
      for (const scheme of ["Token", "Bearer"]) {
        try {
          const r = await fetch(donationsUrl, {
            headers: {
              "authorization": `${scheme} ${token}`,
              "accept":        "application/json",
              "user-agent":    "teatrade-run-reconciler/1.0",
            },
            cf: { cacheTtl: 0 },
          });
          const txt = await r.text();
          attempts.push({
            what:    "donations",
            url:     donationsUrl,
            scheme,
            status:  r.status,
            snippet: txt.slice(0, 160),
          });
          if (r.ok) {
            try {
              const payload = JSON.parse(txt);
              const list = listFromPayload(payload);
              if (list.length || Array.isArray(payload)) {
                donations = normaliseDonations(payload);
                rawSample = sampleRawDonation(payload);
                donationsOk = true;
                break outer;
              }
            } catch { /* not JSON — keep trying other candidates */ }
          }
          // 401/403 means auth scheme wrong on this path — try other scheme.
          // 404 means path wrong — break inner, move to next path.
          if (r.status === 404) break;
        } catch (e) {
          attempts.push({ what: "donations", url: donationsUrl, scheme, error: String(e && e.message || e) });
        }
      }
    }
  }

  // 3. raised_total — prefer the summary endpoint (always works,
  //    matches what donors see on the GiveWheel page). Fall back
  //    to summing the donations list if the summary call failed.
  //    If both failed, leave the existing value so the number
  //    doesn't blink to 0 on a transient outage.
  if (summaryTotal != null) {
    if (summaryTotal !== data.raised_total) {
      data.raised_total = summaryTotal;
      changed = true;
    }
  } else if (donationsOk) {
    const newTotal = donations.reduce((acc, d) => acc + (d.amount || 0), 0);
    if (newTotal !== data.raised_total) {
      data.raised_total = newTotal;
      changed = true;
    }
  }

  // 4. Match donations to pending pixel claims.
  if (donationsOk && donations.length) {
    const alreadyConfirmed = new Set(
      data.sponsorships.map(s => String(s.gw_id || "")).filter(Boolean)
    );
    const orphanIds = new Set(
      (data.orphan_donations || []).map(d => String(d.gw_id))
    );

    for (const d of donations) {
      const gwId = String(d.id);
      if (alreadyConfirmed.has(gwId)) continue;

      // Try to match a pending mile claim.
      const pIdx = data.pending.findIndex(p => isMatch(p, d));
      if (pIdx >= 0) {
        const p = data.pending[pIdx];
        data.sponsorships.push({
          pixel:        p.pixel,
          sponsor:      p.sponsor_name,
          initials:     initialsFor(p.sponsor_name),
          logo:         p.logo_url || "",
          logoBg:       p.donor_type === "corporate" ? "#202124"
                      : (p.tier === "premium"  ? "#c5a572"
                      : (p.tier === "featured" ? "#1a73e8"
                      : "#f56600")),
          amount:       d.amount,
          tier:         p.tier,
          message:      p.message || d.message || "",
          gw_id:        gwId,
          confirmed_ms: now,
        });
        data.pending.splice(pIdx, 1);
        orphanIds.delete(gwId);
        alreadyConfirmed.add(gwId);
        changed = true;
        continue;
      }

      // Try a generic "donate any amount" pending.
      const gIdx = data.general_pending.findIndex(p => isMatch(p, d));
      if (gIdx >= 0) {
        const p = data.general_pending[gIdx];
        data.general_donations.push({
          sponsor:      p.sponsor_name,
          donor_type:   p.donor_type,
          amount:       d.amount,
          message:      p.message || d.message || "",
          gw_id:        gwId,
          confirmed_ms: now,
        });
        data.general_pending.splice(gIdx, 1);
        orphanIds.delete(gwId);
        changed = true;
        continue;
      }

      // No pending row, but the donation carries our lock code.
      // The code is an idempotent identifier (the pending row was
      // only ever a UI hold to prevent double-bookings during
      // checkout). Recover the pixel from the code itself.
      const recovered = recoverFromCode(d, data);
      if (recovered) {
        data.sponsorships.push({ ...recovered, gw_id: gwId, confirmed_ms: now });
        orphanIds.delete(gwId);
        alreadyConfirmed.add(gwId);
        changed = true;
        continue;
      }

      // Unmatched — track as an orphan so it shows up in the donor
      // wall and can be manually assigned to a pixel later.
      if (!orphanIds.has(gwId)) {
        data.orphan_donations.push({
          gw_id:    gwId,
          name:     d.name || "Anonymous",
          message:  d.message || "",
          amount:   d.amount,
          date:     d.dateIso || null,
          seen_ms:  now,
        });
        orphanIds.add(gwId);
        changed = true;
      }
    }

    // Prune the orphan list to the last 200 entries to keep KV small.
    if (data.orphan_donations.length > 200) {
      data.orphan_donations = data.orphan_donations.slice(-200);
    }
  }

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
    pending_pixels:    data.pending.map(p => p.pixel),
    orphan_donations:  data.orphan_donations.map(o => ({
      gw_id: o.gw_id, name: o.name, message: o.message, amount: o.amount, date: o.date,
    })),
    _diag: {
      summary_total:         summaryTotal,
      summary_supporters:    summarySupporters,
      donations_ok:          donationsOk,
      donation_count:        donations.length,
      fetch_err:             fetchErr,
      pending_count:         data.pending.length,
      general_pending_count: data.general_pending.length,
      orphan_count:          data.orphan_donations.length,
      gw_raw_keys:           rawSample ? Object.keys(rawSample) : null,
      attempts,
    },
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

// -- matching ----------------------------------------------------
//
// Primary key: d_question_1 (the random M{pixel}-{XXXX} lock code
// we sent the donor to GiveWheel with). This is deterministic and
// confirmed by GiveWheel's technical co-founder as being returned
// on the authenticated donations endpoint.
//
// Fallbacks: name + amount, then message + amount. These cover the
// case where a donor manually navigates to the GiveWheel page and
// types their details without going through our claim flow.
function isMatch(pending, donation) {
  if (!donation || !Number.isFinite(donation.amount)) return false;

  // Code match — amount-agnostic on purpose (a donor may bump the
  // amount up on GiveWheel; the lock code still identifies them).
  if (pending.code && donation.code && normalise(donation.code) === normalise(pending.code)) {
    return true;
  }

  if (donation.amount !== pending.amount) return false;

  if (donation.ts && pending.created_ms && donation.ts < pending.created_ms - 5 * 60 * 1000) {
    return false;
  }

  const pName = normalise(pending.sponsor_name);
  const pMsg  = normalise(pending.message);
  const dName = normalise(donation.name);
  const dMsg  = normalise(donation.message);

  if (pName && dName && (pName === dName || dName.includes(pName) || pName.includes(dName))) return true;
  if (pMsg  && dMsg  && (pMsg  === dMsg  || dMsg.includes(pMsg))) return true;

  return false;
}

// -- helpers -----------------------------------------------------

// If a donation carries our M{pixel}-XXXX lock code and the pixel
// is still free, reconstruct a sponsorship from the donation data.
// This is the safety net for donors whose pending row expired
// before the next sweep ran (or before we deployed reconciliation
// at all). The lock code itself is the source of truth.
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
    logo:     "", // logo only existed in the (now expired) pending row
    logoBg:   tier === "patron"  ? "#1a73e8"
            : tier === "premium" ? "#c5a572"
            : "#f56600",
    amount:   d.amount,
    tier,
    message:  d.message || "",
    recovered_from_code: true,
  };
}

function normaliseDonations(payload) {
  const list = listFromPayload(payload);
  return list.map(d => {
    const rawAmt = d.donationamount ?? d.amount ?? d.donation_amount ?? d.value;
    const amount = typeof rawAmt === "string" ? parseFloat(rawAmt) : Number(rawAmt);
    const ts = d.transaction_date ? Date.parse(d.transaction_date) : null;
    return {
      id:      d.id ?? d.donation_identifier ?? `${d.Name}|${rawAmt}|${d.transaction_date}`,
      amount:  Number.isFinite(amount) ? Math.round(amount) : 0,
      name:    extractQuestion(d, 2) || d.Name || d.name || d.donor_name || "",
      message: extractQuestion(d, 3) || d.Message || d.message || "",
      code:    extractQuestion(d, 1),
      ts,
      dateIso: d.transaction_date || null,
    };
  }).filter(d => d.amount > 0);
}

function listFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data))    return payload.data;
  return [];
}

function sampleRawDonation(payload) {
  const list = listFromPayload(payload);
  return list[0] || null;
}

// Pulls the answer to a custom question (1, 2, 3...) out of a
// GiveWheel donation record. The exact field name isn't documented
// in the public schema, so we look in every plausible place. As
// soon as we see a live response we can simplify this.
function extractQuestion(d, n) {
  const candidates = [
    `d_question_${n}`,
    `question_${n}`,
    `q${n}`,
    `Question${n}`,
    `question${n}`,
    `custom_${n}`,
    `custom_field_${n}`,
  ];
  for (const k of candidates) {
    if (d[k] != null && d[k] !== "") return String(d[k]);
  }
  // Some APIs nest answers under `questions` / `responses` / `answers`.
  const containers = [d.questions, d.responses, d.answers, d.donor_questions, d.custom_questions];
  for (const c of containers) {
    if (!c) continue;
    if (Array.isArray(c)) {
      // [{question: "Mile reference", answer: "M63-AB12"}] or [{id: 1, value: "..."}]
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

function normalise(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function initialsFor(name) {
  return (name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");
}

function freshState() {
  return {
    sponsorships:      [],
    pending:           [],
    general_pending:   [],
    general_donations: [],
    orphan_donations:  [],
    raised_total:      0,
    raised_goal:       19000,
    updated:           null,
  };
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
