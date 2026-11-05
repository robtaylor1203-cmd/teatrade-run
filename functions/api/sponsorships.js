/**
 * GET /api/sponsorships
 * --------------------------------------------------------------
 * Public read endpoint. Also drives reconciliation between GiveWheel and
 * our KV store.
 *
 *   1. raised_total comes from GiveWheel's public summary endpoint.
 *   2. Per-donation detail comes from the authenticated donations API.
 *      Each donation is matched to a pending claim by the lock code we sent
 *      as d_question_1 (M{mile}-XXXX or g_xxxx) and promoted to a confirmed
 *      sponsorship. Unmatched donations become `orphan_donations` for manual
 *      attribution via /api/admin/assign-pixel.
 *   3. The public response is cached at the edge for a few seconds so
 *      launch-day traffic costs one GiveWheel round-trip per colo, not one
 *      per visitor. Donor details and diagnostics are only returned to
 *      requests carrying the admin secret in `x-admin-secret`.
 *
 * Env vars (Cloudflare Pages):
 *   GIVEWHEEL_USERNAME / GIVEWHEEL_PASSWORD   Knox token minting (auto-refresh)
 *   GIVEWHEEL_FUNDRAISING_ID                  Optional, auto-resolved from summary
 *   GIVEWHEEL_API_TOKEN                       Optional static token fallback
 *   ADMIN_SECRET                              Unlocks admin-only fields
 */
import {
  ensureShape, isActive, reconcileAll, persistLogo, cleanLogo, safeEqual,
  PENDING_KEEP_MS,
} from "../_lib/sponsor.js";
import { notifyAll } from "../_lib/email.js";

const TOKEN_KV_KEY  = "gw_token";
const TOKEN_SKEW_MS = 5 * 60 * 1000;   // refresh a bit before real expiry
const CACHE_SECONDS = 15;
const GW_TIMEOUT_MS = 8000;

export async function onRequestGet(context) {
  const { request, env } = context;
  const isAdmin = !!env.ADMIN_SECRET &&
    safeEqual(request.headers.get("x-admin-secret") || "", env.ADMIN_SECRET);

  const cache    = globalThis.caches?.default;
  const cacheKey = new Request(new URL("/api/sponsorships", request.url).toString());

  if (!isAdmin && cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { status: 200, headers: BROWSER_HEADERS });
    } catch { /* fall through to a live sync */ }
  }

  const fundraisingId = env.GIVEWHEEL_FUNDRAISING_ID || "16454";
  const attempts = [];

  // -- 1. Pull authoritative data from GiveWheel (no KV state needed yet) --
  let donations         = [];
  let fetchErr          = null;
  let donationsOk       = false;
  let summaryTotal      = null;
  let summarySupporters = null;
  let summaryId         = null;
  let rawSample         = null;

  // (a) Public summary. The endpoint matches on an exact donor-facing URL so
  //     try the known forms in turn.
  const shortlink   = env.GIVEWHEEL_SHORTLINK || "https://gvwhl.com/ORSR6";
  const slug        = env.GIVEWHEEL_SLUG      || "run-teatrade";
  const summaryUrls = [
    shortlink,
    `https://www.givewheel.com/fundraising/${fundraisingId}/${slug}/`,
    `https://www.givewheel.com/fundraising/${fundraisingId}/`,
  ];
  for (const candidate of summaryUrls) {
    try {
      const url = `https://www.givewheel.com/api/fundraisings/url/?url=${encodeURIComponent(candidate)}`;
      const r   = await gwFetch(url, { headers: { "accept": "application/json", "user-agent": UA } });
      const txt = await r.text();
      attempts.push({ what: "summary", url: candidate, status: r.status, snippet: txt.slice(0, 160) });
      if (r.ok) {
        const j = JSON.parse(txt);
        summaryTotal      = Number(j.amount_raised) || Number(j.total_raised) || 0;
        summarySupporters = Number(j.supporters) || 0;
        summaryId         = j.id ?? null;
        fetchErr = null;
        break;
      }
      fetchErr = `summary_http_${r.status}`;
    } catch (e) {
      attempts.push({ what: "summary", url: candidate, error: String(e && e.message || e) });
      fetchErr = "summary_failed";
    }
  }

  // (b) Per-donation list. Uses the numeric id from the summary so a
  //     misconfigured env var can't break attribution. Knox tokens expire,
  //     so the token is cached in KV and refreshed on 401.
  const apiId = summaryId || fundraisingId;
  let tokenMeta = null;
  if ((env.GIVEWHEEL_USERNAME && env.GIVEWHEEL_PASSWORD) || env.GIVEWHEEL_API_TOKEN) {
    tokenMeta = await getKnoxToken(env, attempts);
  }

  if (tokenMeta?.token) {
    const donationsUrl = `https://www.givewheel.com/api/fundraisings/${apiId}/donations/`;
    for (let pass = 0; pass < 2; pass++) {
      try {
        const r = await gwFetch(donationsUrl, {
          headers: {
            "authorization": `Token ${tokenMeta.token}`,
            "accept":        "application/json",
            "user-agent":    UA,
          },
        });
        const txt = await r.text();
        attempts.push({
          what: "donations", url: donationsUrl, pass,
          token_source: tokenMeta.source, status: r.status,
          snippet: r.ok ? `(${txt.length} bytes)` : txt.slice(0, 200),
        });
        if (r.ok) {
          try {
            const payload = JSON.parse(txt);
            donations   = normaliseDonations(payload);
            rawSample   = listFromPayload(payload)[0] || null;
            donationsOk = true;
          } catch { /* not JSON */ }
          break;
        }
        if (r.status === 401 && pass === 0 && env.GIVEWHEEL_USERNAME && env.GIVEWHEEL_PASSWORD) {
          tokenMeta = await getKnoxToken(env, attempts, { force: true });
          if (!tokenMeta?.token) break;
          continue;
        }
        break;
      } catch (e) {
        attempts.push({ what: "donations", url: donationsUrl, error: String(e && e.message || e) });
        break;
      }
    }
  }

  // -- 2. Read KV fresh, apply, write. Reading AFTER the slow external calls
  //       keeps the window for overwriting a just-created claim to a few ms.
  const raw  = await env.SPONSORSHIPS_KV.get("data");
  const data = ensureShape(raw ? JSON.parse(raw) : {});
  const now  = Date.now();
  let changed = false;
  let outcomes = [];
  let notifications = [];

  // Forget claims we've held long enough (expired claims are kept for a while
  // so a late payment still gets its logo and message).
  const beforeP  = data.pending.length;
  const beforeGP = data.general_pending.length;
  data.pending         = data.pending.filter(p => now - (p.created_ms || 0) < PENDING_KEEP_MS);
  data.general_pending = data.general_pending.filter(p => now - (p.created_ms || 0) < PENDING_KEEP_MS);
  if (data.pending.length !== beforeP || data.general_pending.length !== beforeGP) changed = true;

  // raised_total: summary first (matches what donors see on GiveWheel),
  // else the donations list; if both failed keep the last value so the
  // number doesn't blink to 0 on a transient outage.
  const newTotal = summaryTotal != null ? summaryTotal
                 : donationsOk          ? donations.reduce((a, d) => a + (d.amount || 0), 0)
                 : null;
  if (newTotal != null && newTotal !== data.raised_total) {
    data.raised_total = newTotal;
    changed = true;
  }

  if (donationsOk && donations.length) {
    const rec = reconcileAll(data, donations, now);
    outcomes = rec.outcomes;
    notifications = rec.notifications;
    if (rec.changed) changed = true;

    // Paid mile claims: make their uploaded logo permanent.
    for (const o of outcomes) {
      if (o.kind !== "pending_match") continue;
      const s = data.sponsorships.find(x => x.pixel === o.pixel);
      try { await persistLogo(env, s?.logo); }
      catch (e) { attempts.push({ what: "persist_logo", pixel: o.pixel, error: String(e && e.message || e) }); }
    }
  }

  let writeError = null;
  if (changed) {
    data.updated = new Date().toISOString();
    try { await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data)); }
    catch (e) { writeError = String(e && e.message || e); }
  }

  // Only email once the confirmation is saved; Resend de-duplicates on the
  // donation id if two overlapping polls both get this far.
  if (!writeError && notifications.length) context.waitUntil(notifyAll(env, notifications));

  // -- 3. Respond ---------------------------------------------------------
  const body = {
    updated:      data.updated,
    raised_total: data.raised_total || 0,
    raised_goal:  data.raised_goal  || 19000,
    sponsorships: data.sponsorships.map(s => ({
      pixel:      s.pixel,
      sponsor:    s.sponsor,
      initials:   s.initials,
      logo:       cleanLogo(s.logo, { allowHttps: true }),
      logoBg:     s.logoBg,
      donor_type: s.donor_type || (s.logoBg === "#202124" ? "corporate" : "individual"),
      amount:     s.amount,
      tier:       s.tier,
      message:    s.message,
    })),
    pending_pixels: data.pending.filter(p => isActive(p, now)).map(p => p.pixel),
  };

  if (isAdmin) {
    body.orphan_donations = data.orphan_donations;
    body.pending_claims   = data.pending.filter(p => isActive(p, now))
      .map(p => ({ pixel: p.pixel, code: p.code, sponsor: p.sponsor_name, created_ms: p.created_ms }));
    body._diag = {
      summary_total:         summaryTotal,
      summary_supporters:    summarySupporters,
      summary_id:            summaryId,
      api_id_used:           apiId,
      env_fundraising_id:    fundraisingId,
      donations_ok:          donationsOk,
      donation_count:        donations.length,
      token_source:          tokenMeta?.source || null,
      token_expiry:          tokenMeta?.expiry || null,
      fetch_err:             fetchErr,
      kv_write_error:        writeError,
      pending_count:         data.pending.length,
      general_pending_count: data.general_pending.length,
      general_donation_count: data.general_donations.length,
      orphan_count:          data.orphan_donations.length,
      outcomes,
      gw_raw_keys:           rawSample ? Object.keys(rawSample) : null,
      gw_raw_sample:         rawSample,
      attempts,
    };
    return new Response(JSON.stringify(body), { status: 200, headers: BROWSER_HEADERS });
  }

  const json = JSON.stringify(body);
  // Only cache a response built from a healthy GiveWheel summary.
  if (cache && fetchErr === null) {
    const cached = new Response(json, {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
    });
    context.waitUntil(cache.put(cacheKey, cached).catch(() => {}));
  }
  return new Response(json, { status: 200, headers: BROWSER_HEADERS });
}

const UA = "teatrade-run-reconciler/1.0";

const BROWSER_HEADERS = {
  "content-type":                "application/json",
  "cache-control":               "no-store",
  "access-control-allow-origin": "*",
};

function gwFetch(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(GW_TIMEOUT_MS), cf: { cacheTtl: 0 } });
}

// -- helpers -----------------------------------------------------

// Resolve a usable Knox token. Priority:
//   1. Cached KV token (if not near expiry and force=false)
//   2. Fresh login via GIVEWHEEL_USERNAME/PASSWORD Basic auth
//   3. Static GIVEWHEEL_API_TOKEN env var (legacy fallback)
async function getKnoxToken(env, attempts, { force = false } = {}) {
  if (!force) {
    try {
      const cached = await env.SPONSORSHIPS_KV.get(TOKEN_KV_KEY, { type: "json" });
      if (cached?.token && cached?.expiry) {
        const expMs = Date.parse(cached.expiry);
        if (Number.isFinite(expMs) && expMs - TOKEN_SKEW_MS > Date.now()) {
          return { token: cached.token, expiry: cached.expiry, source: "kv_cache" };
        }
      } else if (cached?.token) {
        return { token: cached.token, expiry: null, source: "kv_cache_no_expiry" };
      }
    } catch (e) {
      attempts.push({ what: "token_cache_read", error: String(e && e.message || e) });
    }
  }

  if (env.GIVEWHEEL_USERNAME && env.GIVEWHEEL_PASSWORD) {
    try {
      const basic = btoa(`${env.GIVEWHEEL_USERNAME}:${env.GIVEWHEEL_PASSWORD}`);
      const r = await gwFetch("https://www.givewheel.com/api/auth/login/", {
        method:  "POST",
        headers: { "authorization": `Basic ${basic}`, "accept": "application/json", "user-agent": UA },
      });
      const txt = await r.text();
      attempts.push({ what: "token_login", status: r.status, snippet: r.ok ? "(token issued)" : txt.slice(0, 160) });
      if (r.ok) {
        const j = JSON.parse(txt);
        const meta = { token: j.token, expiry: j.expiry || null, source: "fresh_login" };
        try {
          // Use the expiry as the KV TTL so KV cleans up after itself.
          const ttlSec = meta.expiry
            ? Math.max(60, Math.floor((Date.parse(meta.expiry) - Date.now()) / 1000))
            : 60 * 60 * 12;
          await env.SPONSORSHIPS_KV.put(TOKEN_KV_KEY, JSON.stringify(meta), { expirationTtl: ttlSec });
        } catch (e) {
          attempts.push({ what: "token_cache_write", error: String(e && e.message || e) });
        }
        return meta;
      }
    } catch (e) {
      attempts.push({ what: "token_login", error: String(e && e.message || e) });
    }
  }

  if (env.GIVEWHEEL_API_TOKEN) {
    return { token: env.GIVEWHEEL_API_TOKEN, expiry: null, source: "env_static" };
  }
  return null;
}

function normaliseDonations(payload) {
  return listFromPayload(payload).map(d => {
    const rawAmt = d.donationamount ?? d.amount ?? d.donation_amount ?? d.value;
    const amount = typeof rawAmt === "string" ? parseFloat(rawAmt) : Number(rawAmt);
    const ts = d.transaction_date ? Date.parse(d.transaction_date) : null;
    return {
      id:      d.id ?? d.donation_identifier ?? `${d.Name}|${rawAmt}|${d.transaction_date}`,
      amount:  Number.isFinite(amount) ? Math.round(amount) : 0,
      name:    extractQuestion(d, 2) || d.Name || d.name || d.donor_name || "",
      message: extractQuestion(d, 3) || d.Message || d.message || "",
      code:    findLockCode(d),
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

// Our lock codes look like M63-AB12 (mile) or g_1a2b3c4d5e (general). Prefer
// the answer to question 1, but if the question order ever differs scan every
// answer for something that looks like one of ours.
const OUR_CODE = /^(?:M\d{1,3}-[A-Z0-9]{4}|g_[0-9a-f]{10})$/i;
function findLockCode(d) {
  const q1 = extractQuestion(d, 1);
  if (OUR_CODE.test(q1.trim())) return q1.trim();
  const lists = [d.supporter_questions, d.questions, d.responses, d.answers].filter(Array.isArray);
  for (const list of lists) {
    for (const e of list) {
      const v = String(e?.answer ?? e?.value ?? e?.response ?? e?.text ?? "").trim();
      if (OUR_CODE.test(v)) return v;
    }
  }
  return q1;
}

// Pulls the answer to custom question n out of a GiveWheel donation record.
// The live shape is `supporter_questions: [{question_id, question, response}]`.
function extractQuestion(d, n) {
  const flat = [
    `d_question_${n}`, `question_${n}`, `q${n}`,
    `Question${n}`, `question${n}`, `custom_${n}`, `custom_field_${n}`,
  ];
  for (const k of flat) {
    if (d[k] != null && d[k] !== "") return String(d[k]);
  }
  const containers = [
    d.supporter_questions, d.questions, d.responses, d.answers,
    d.donor_questions,     d.custom_questions,
  ];
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
