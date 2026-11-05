/**
 * POST /api/auction/bid
 * Takes a sealed bid in-house (replaces Formspree). The bid does NOT count
 * until the bidder confirms it from the email we send them.
 */
import { submitBid } from "../../_lib/auction.js";
import { hashIp } from "../../_lib/sponsor.js";

const STATUS = {
  closed: 403, bad_item: 400, bad_amount: 400, bad_company: 400, bad_email: 400,
  too_many: 429, busy: 429, email_unavailable: 503, email_failed: 502,
};

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }

  // Hidden field real visitors never fill in: pretend success so bots move on.
  if (body?.website) return json({ ok: true });

  const res = await submitBid(env, {
    itemId:  body?.item,
    amount:  body?.bid_amount,
    company: body?.company_name,
    email:   body?.contact_email,
    ipHash:  await hashIp(request),
  }, Date.now());

  if (res.error) return json(res, STATUS[res.error] || 400);
  return json({ ok: true });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
