/**
 * GET  /api/auction/confirm?t=TOKEN   shows the bid and a Confirm button
 * POST /api/auction/confirm           confirms the bid
 *
 * Confirming is a POST on purpose: corporate mail scanners open links in
 * emails, and a GET that changed state would confirm bids nobody approved.
 */
import { getSub, confirmBid, sendReceipt } from "../../_lib/auction.js";
import { AUCTION_CLOSES_MS, itemById, fmtDate, fmtDateTime, gbp } from "../../_lib/auction-config.js";
import { escapeHtml as esc } from "../../_lib/email.js";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
};

const toAscii = (s) => s.replace(/[^\x00-\x7F]/gu, c => `&#${c.codePointAt(0)};`);

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Run TeaTrade</title>
<style>body{margin:0;background:#f6f6f6;font-family:Roboto,Arial,sans-serif;color:#202124}.c{max-width:520px;margin:40px auto;padding:0 16px}.card{background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:28px 26px}.eb{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#f56600;font-weight:600}h1{font-size:24px;line-height:1.25;margin:8px 0 14px}p{font-size:15px;line-height:1.55;margin:0 0 14px}table{border-collapse:collapse;margin:0 0 18px;background:#f8f8f8;border-radius:10px;width:100%}td{padding:6px 12px;font-size:14px}td:first-child{color:#5f6368;white-space:nowrap}td:last-child{font-weight:600}button,a.b{display:inline-block;background:#f56600;color:#fff;border:0;text-decoration:none;font:600 15px Roboto,Arial,sans-serif;padding:12px 22px;border-radius:999px;cursor:pointer}.m{color:#5f6368;font-size:13px}</style></head>
<body><div class="c"><div class="card"><div class="eb">Run TeaTrade</div><h1>${esc(title)}</h1>${body}</div></div></body></html>`;
  return new Response(toAscii(html), { status, headers: HEADERS });
}

const facts = (b) => `<table>
<tr><td>Item</td><td>${esc(itemById(b.item)?.name || b.item)}</td></tr>
<tr><td>Your bid</td><td>${esc(gbp(b.amount))}</td></tr>
<tr><td>Company</td><td>${esc(b.company)}</td></tr>
<tr><td>Bidding closes</td><td>${esc(fmtDateTime(AUCTION_CLOSES_MS))}</td></tr></table>`;

const back = `<p><a class="b" href="https://run.teatrade.co.uk/#gear">Back to the run site</a></p>`;

function problem(error) {
  switch (error) {
    case "closed":     return page("Bidding has closed", `<p>This bid wasn't confirmed before bidding closed on ${esc(fmtDate(AUCTION_CLOSES_MS))}, so it can't be counted. Thank you for your interest, and please do consider sponsoring a mile or donating on the site.</p>${back}`);
    case "superseded": return page("You've placed a newer bid", `<p>You've since submitted a newer bid for this item, so this older one can't be confirmed. Please use the confirmation link in your most recent email.</p>${back}`);
    default:           return page("This link isn't valid", `<p>This confirmation link is invalid or has expired. You can place your bid again on the run site.</p>${back}`, 404);
  }
}

export async function onRequestGet({ request, env }) {
  const sub = await getSub(env, new URL(request.url).searchParams.get("t"));
  if (!sub) return problem("invalid");
  if (Date.now() >= AUCTION_CLOSES_MS) return problem("closed");
  return page("Confirm your bid", `<p>Please check the details below and confirm. Your bid only counts once you do.</p>${facts(sub)}
<form method="post" action="/api/auction/confirm"><input type="hidden" name="t" value="${esc(sub.token)}"><button type="submit">Confirm my bid</button></form>
<p class="m" style="margin-top:16px">This is a sealed auction: bids are private and never published.</p>`);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let token = "";
  try { token = String((await request.formData()).get("t") || ""); } catch { /* invalid */ }

  const res = await confirmBid(env, token, Date.now());
  if (res.error) return problem(res.error);

  if (!res.already) context.waitUntil(sendReceipt(env, res.bid));
  return page(res.already ? "Already confirmed" : "Your bid is confirmed", `<p>Thank you, ${esc(res.bid.company)}. ${res.already ? "This bid was already confirmed." : "We've emailed you a receipt."}</p>${facts(res.bid)}
<p class="m">When bidding closes on ${esc(fmtDate(AUCTION_CLOSES_MS))} the highest confirmed bid wins and the winner is told by email. To change your bid, submit a new bid for the same item with this email address and confirm it; your latest confirmed bid counts.</p>${back}`);
}
