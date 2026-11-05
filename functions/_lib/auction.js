/**
 * Gear auction logic (sealed-bid). Storage is the existing KV namespace:
 *   sub:<token>               a submitted, not-yet-confirmed bid (14 day TTL)
 *   bid:<item>:<emailhash>    the confirmed bid for that bidder + item; the
 *                             metadata carries amount/company/email/time so the
 *                             tally and admin view need no extra reads
 *   auction:state             results after close (offers, outbox, reminders)
 *   rl:*                      small rate-limit counters
 * One writer per bid key (the bidder), so there are no lost updates; the tally
 * runs after close + a short grace so KV listings have settled.
 */
import { cleanText, randomId } from "./sponsor.js";
import { cleanEmail } from "./email.js";
import {
  AUCTION_CLOSES_MS, PAY_BY_MS, CLOSE_GRACE_MS, DAY_MS, MAX_BID, ITEMS, itemById,
} from "./auction-config.js";
import {
  verifyEmail, receiptEmail, nudgeEmail, wonEmail, lostEmail, reminderEmail,
  paidEmail, ownerClosedEmail, ownerPaidEmail, ownerLapsedEmail, ownerAddress, deliver,
} from "./auction-email.js";
import { sleep } from "./email.js";

const SITE = "https://run.teatrade.co.uk";
const STATE_KEY = "auction:state";
const SUB_TTL_SEC = 14 * 24 * 60 * 60;

// Limits that keep a bot from burning the (shared) Resend daily quota.
const LIMIT_PER_IP_HOUR = 8;
const LIMIT_PER_EMAIL_DAY = 5;
const LIMIT_GLOBAL_DAY = 60;
const OUTBOX_PER_TICK = 20;

const kvGet  = (env, k, o) => env.SPONSORSHIPS_KV.get(k, o);
const kvPut  = (env, k, v, o) => env.SPONSORSHIPS_KV.put(k, typeof v === "string" ? v : JSON.stringify(v), o);

async function sha(s, bytes = 10) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, bytes), b => b.toString(16).padStart(2, "0")).join("");
}
const emailHash = (email) => sha("auction-em:" + email);
const confirmLink = (token) => `${SITE}/api/auction/confirm?t=${encodeURIComponent(token)}`;
const bidKey = (itemId, hash) => `bid:${itemId}:${hash}`;

// Approximate counter. Returns false once `limit` is reached.
async function hit(env, key, limit, ttlSec) {
  const n = Number(await kvGet(env, key)) || 0;
  if (n >= limit) return false;
  await kvPut(env, key, String(n + 1), { expirationTtl: ttlSec });
  return true;
}
const day  = (now) => new Date(now).toISOString().slice(0, 10);
const hour = (now) => new Date(now).toISOString().slice(0, 13);

// -- bids --------------------------------------------------------------------

export async function submitBid(env, { itemId, amount, company, email, ipHash }, now) {
  if (now >= AUCTION_CLOSES_MS) return { error: "closed" };
  const item = itemById(itemId);
  if (!item) return { error: "bad_item" };

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < item.min || amt > MAX_BID) {
    return { error: "bad_amount", min: item.min };
  }
  const name  = cleanText(company, 80);
  const addr  = cleanEmail(email);
  if (!name) return { error: "bad_company" };
  if (!addr) return { error: "bad_email" };
  if (!env.RESEND_API_KEY) return { error: "email_unavailable" };

  const eh = await emailHash(addr);
  if (ipHash && !(await hit(env, `rl:ip:${ipHash}:${hour(now)}`, LIMIT_PER_IP_HOUR, 2 * 3600))) return { error: "too_many" };
  if (!(await hit(env, `rl:em:${eh}:${day(now)}`, LIMIT_PER_EMAIL_DAY, 2 * 86400))) return { error: "too_many" };
  if (!(await hit(env, `rl:all:${day(now)}`, LIMIT_GLOBAL_DAY, 2 * 86400))) return { error: "busy" };

  const token = randomId(24);
  const sub = { token, item: item.id, amount: amt, company: name, email: addr, ts: now };
  await kvPut(env, `sub:${token}`, sub, {
    expirationTtl: SUB_TTL_SEC,
    metadata: { item: item.id, amount: amt, ts: now },
  });

  const sent = await deliver(env, addr, verifyEmail(sub, confirmLink(token)), `bid-verify-${token}`);
  if (!sent) {
    await env.SPONSORSHIPS_KV.delete(`sub:${token}`);
    return { error: "email_failed" };
  }
  return { ok: true };
}

export async function getSub(env, tokenRaw) {
  const token = String(tokenRaw || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{24}$/.test(token)) return null;
  return (await kvGet(env, `sub:${token}`, { type: "json" })) || null;
}

// Confirms the bid for a submission token. The latest confirmed submission for
// an (item, email) pair wins; an older link can't overwrite a newer bid.
export async function confirmBid(env, tokenRaw, now) {
  const sub = await getSub(env, tokenRaw);
  if (!sub) return { error: "invalid" };
  if (now >= AUCTION_CLOSES_MS) return { error: "closed", sub };

  const key = bidKey(sub.item, await emailHash(sub.email));
  const existing = await kvGet(env, key, { type: "json" });
  if (existing && existing.token === sub.token) return { ok: true, already: true, sub, bid: existing };
  if (existing && existing.subTs > sub.ts) return { error: "superseded", sub };

  const bid = {
    item: sub.item, amount: sub.amount, company: sub.company, email: sub.email,
    token: sub.token, subTs: sub.ts, confirmedAt: now,
  };
  await kvPut(env, key, bid, {
    metadata: { amount: bid.amount, company: bid.company, email: bid.email, confirmedAt: now },
  });
  return { ok: true, sub, bid };
}

export async function sendReceipt(env, bid) {
  return deliver(env, bid.email, receiptEmail(bid), `bid-receipt-${bid.token}`);
}

async function listPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.SPONSORSHIPS_KV.list({ prefix, cursor, limit: 1000 });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// Confirmed bids for one item, best first: highest amount, then earliest confirmation.
export async function listBids(env, itemId) {
  const keys = await listPrefix(env, `bid:${itemId}:`);
  return keys
    .map(k => ({ key: k.name, item: itemId, ...(k.metadata || {}) }))
    .filter(b => Number.isFinite(b.amount))
    .sort((a, b) => b.amount - a.amount || (a.confirmedAt || 0) - (b.confirmedAt || 0));
}

// -- state -------------------------------------------------------------------

export const readState = async (env) => (await kvGet(env, STATE_KEY, { type: "json" })) || null;
const writeState = (env, s) => kvPut(env, STATE_KEY, s);

export async function publicStatus(env, now) {
  const open = now < AUCTION_CLOSES_MS;
  const state = open ? null : await readState(env);
  return {
    open,
    closes: new Date(AUCTION_CLOSES_MS).toISOString(),
    pay_by: new Date(PAY_BY_MS).toISOString(),
    items: ITEMS.map(i => {
      const st = state?.items?.[i.id];
      return {
        id: i.id, name: i.name, min: i.min,
        status: open ? "open" : (st?.status === "paid" ? "paid" : "closed"),
        ...(st?.status === "paid" ? { sponsor: st.company } : {}),
      };
    }),
  };
}

// -- scheduled work (called from the public status endpoint and the 5-min job) -

async function nudgeUnconfirmed(env, now) {
  const subs = await listPrefix(env, "sub:");
  const confirmed = new Set();
  for (const item of ITEMS) for (const b of await listBids(env, item.id)) confirmed.add(`${b.item}:${b.key.split(":")[2]}`);

  // One reminder per bidder + item (their latest unconfirmed submission).
  const latest = new Map();
  for (const k of subs) {
    const sub = await kvGet(env, k.name, { type: "json" });
    if (!sub) continue;
    const pair = `${sub.item}:${await emailHash(sub.email)}`;
    if (confirmed.has(pair)) continue;
    if (!latest.has(pair) || latest.get(pair).ts < sub.ts) latest.set(pair, sub);
  }

  let sent = 0;
  for (const sub of latest.values()) {
    if (sent++ > 0) await sleep(Number(env.RESEND_GAP_MS ?? 150));
    await deliver(env, sub.email, nudgeEmail(sub, confirmLink(sub.token)), `bid-nudge-${sub.token}`);
  }
  return sent;
}

async function closeAuction(env, now) {
  const state = { closedAt: now, items: {}, outbox: [], ownerSent: false, version: 1 };
  for (const item of ITEMS) {
    const bids = await listBids(env, item.id);
    if (!bids.length) { state.items[item.id] = { status: "nobids", item: item.id }; continue; }
    const [win, ...rest] = bids;
    state.items[item.id] = {
      status: "offered", item: item.id, code: `G${item.n}-${randomId(4)}`,
      company: win.company, email: win.email, amount: win.amount, bidders: bids.length,
      deadline: PAY_BY_MS, offeredAt: now, reminded: [],
    };
    state.outbox.push({ kind: "won", item: item.id, sent: false });
    for (const b of rest) {
      state.outbox.push({ kind: "lost", item: item.id, email: b.email, company: b.company, amount: b.amount, sent: false });
    }
  }
  await writeState(env, state);
  return state;
}

async function runOutbox(env, state) {
  const gap = Number(env.RESEND_GAP_MS ?? 150);
  let n = 0;
  for (const e of state.outbox) {
    if (e.sent) continue;
    if (n >= OUTBOX_PER_TICK) break;
    if (n++ > 0 && gap > 0) await sleep(gap);
    let ok = false;
    if (e.kind === "won") {
      const st = state.items[e.item];
      if (st?.status === "offered") ok = await deliver(env, st.email, wonEmail(st), `won-${st.code}`);
      else ok = true;   // superseded by a newer offer or already paid
    } else {
      const eh = await emailHash(e.email);
      ok = await deliver(env, e.email, lostEmail(e), `lost-${e.item}-${eh}`);
    }
    if (ok) e.sent = true;
  }
}

async function runDeadlines(env, state, now) {
  const gap = Number(env.RESEND_GAP_MS ?? 150);
  for (const st of Object.values(state.items)) {
    if (st.status !== "offered") continue;
    const left = st.deadline - now;
    if (left <= 0) {
      st.status = "lapsed";
      await deliver(env, ownerAddress(env), ownerLapsedEmail(st), `lapsed-${st.code}`);
      continue;
    }
    for (const [label, span] of [["1d", DAY_MS], ["3d", 3 * DAY_MS]]) {
      if (st.reminded.includes(label)) continue;
      if (left > span || st.offeredAt >= st.deadline - span) continue;
      st.reminded.push(label);
      if (label === "1d" && !st.reminded.includes("3d")) st.reminded.push("3d");
      await deliver(env, st.email, reminderEmail(st, label), `remind-${label}-${st.code}`);
      await sleep(gap);
      break;
    }
  }
}

// Idempotent and cheap when there is nothing to do. Safe to call often.
export async function tick(env, now) {
  if (!env.SPONSORSHIPS_KV || now < AUCTION_CLOSES_MS - DAY_MS) return;
  let state = await readState(env);

  if (now < AUCTION_CLOSES_MS) {
    if (!state?.nudged) {
      await writeState(env, { ...(state || { items: {}, outbox: [] }), nudged: now });
      await nudgeUnconfirmed(env, now);
    }
    return;
  }
  if (now < AUCTION_CLOSES_MS + CLOSE_GRACE_MS) return;

  let changed = false;
  if (!state?.closedAt) {
    state = await closeAuction(env, now);
    changed = true;
  }
  if (!state.ownerSent) {
    if (await deliver(env, ownerAddress(env), ownerClosedEmail(state), "auction-closed-summary")) {
      state.ownerSent = true; changed = true;
    }
  }
  const before = JSON.stringify(state);
  await runOutbox(env, state);
  await runDeadlines(env, state, now);
  if (changed || JSON.stringify(state) !== before) await writeState(env, state);
}

// -- payments ----------------------------------------------------------------

// Applies unapplied gear payments from the donation ledger. State is updated
// here; the returned send() does the emails once the caller has saved `data`.
export async function applyGearPayments(env, data, now) {
  const pending = (data.gear_payments || []).filter(p => !p.applied);
  if (!pending.length) return { changed: false, send: async () => {} };

  const state = await readState(env);
  const emails = [];
  let stateChanged = false;

  for (const p of pending) {
    const st = state && Object.values(state.items).find(s => s.code === p.code);
    if (!st) {
      p.applied = true; p.problem = "no_matching_offer";
      data.orphan_donations.push({ gw_id: p.gw_id, name: p.name || "Anonymous", message: "", amount: p.amount, code: p.code, reason: "gear_no_offer", date: null, seen_ms: now });
      continue;
    }
    if (p.amount < st.amount) {
      p.applied = true; p.problem = "underpaid";
      data.orphan_donations.push({ gw_id: p.gw_id, name: st.company, message: "", amount: p.amount, code: p.code, reason: "gear_underpaid", date: null, seen_ms: now });
      continue;
    }
    if (st.status !== "paid") {
      st.status = "paid"; st.paidAt = now; st.paidGw = p.gw_id;
      stateChanged = true;
    }
    p.applied = true;
    emails.push(
      () => deliver(env, st.email, paidEmail(st), `paid-${st.code}`),
      () => deliver(env, ownerAddress(env), ownerPaidEmail(st), `paid-owner-${st.code}`),
    );
  }
  if (stateChanged) await writeState(env, state);

  return {
    changed: true,
    send: async () => {
      const gap = Number(env.RESEND_GAP_MS ?? 150);
      for (let i = 0; i < emails.length; i++) {
        if (i > 0 && gap > 0) await sleep(gap);
        try { await emails[i](); } catch (e) { console.error("gear_email_error", String(e && e.message || e)); }
      }
    },
  };
}

// -- admin -------------------------------------------------------------------

export async function adminOverview(env, now) {
  const state = await readState(env);
  const items = [];
  for (const i of ITEMS) {
    items.push({ ...i, bids: await listBids(env, i.id), state: state?.items?.[i.id] || null });
  }
  return { now, closes: AUCTION_CLOSES_MS, pay_by: PAY_BY_MS, closed: !!state?.closedAt, items };
}

// Offer (or re-offer / extend) an item to a specific confirmed bid.
export async function adminOffer(env, { itemId, bidKey: key, days }, now) {
  const item = itemById(itemId);
  if (!item) return { error: "bad_item" };
  const state = await readState(env);
  if (!state?.closedAt) return { error: "not_closed" };
  const bids = await listBids(env, itemId);
  const bid = bids.find(b => b.key === key);
  if (!bid) return { error: "bid_not_found" };
  if (state.items[itemId]?.status === "paid") return { error: "already_paid" };

  const d = Math.min(14, Math.max(1, Math.round(Number(days) || 3)));
  const st = {
    status: "offered", item: itemId, code: `G${item.n}-${randomId(4)}`,
    company: bid.company, email: bid.email, amount: bid.amount, bidders: bids.length,
    deadline: now + d * DAY_MS, offeredAt: now, reminded: [], manual: true,
  };
  state.items[itemId] = st;
  state.outbox.push({ kind: "won", item: itemId, sent: false });
  await writeState(env, state);
  await runOutbox(env, state);
  await writeState(env, state);
  return { ok: true, offer: { item: itemId, company: st.company, amount: st.amount, deadline: st.deadline, code: st.code } };
}
