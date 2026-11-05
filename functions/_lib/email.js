/**
 * Donor emails via Resend. Everything here is best-effort: a failure is logged
 * and never blocks a donation being confirmed.
 *
 * Env (all optional; with no RESEND_API_KEY nothing is sent):
 *   RESEND_API_KEY     Resend API key (Secret)
 *   RESEND_FROM        Defaults to "Run TeaTrade <run@teatrade.co.uk>"
 *   RESEND_REPLY_TO    Optional reply-to override
 *   RESEND_TOPIC_ID    Resend Topic for run updates. Create it with default
 *                      subscription "Opt-out" so only people we explicitly
 *                      subscribe ever receive run updates.
 */
const API         = "https://api.resend.com";
const DEFAULT_FROM = "Run TeaTrade <run@teatrade.co.uk>";
const SITE        = "https://run.teatrade.co.uk";
const TIMEOUT_MS  = 8000;

export function cleanEmail(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s.length <= 254 && /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+$/.test(s) ? s : "";
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function buildConfirmation(n) {
  const isMile = !!n.pixel;
  const gbp    = `£${Number(n.amount || 0).toLocaleString("en-GB")}`;
  const subject = isMile
    ? `Mile ${n.pixel} is yours — thank you | Run TeaTrade`
    : "Thank you for supporting the Run TeaTrade 190-mile run";

  const headline = isMile ? `Mile ${n.pixel} is yours.` : "Thank you.";
  const lead = isMile
    ? `Thank you, ${n.name}. Your ${gbp} donation is confirmed and your name now marks mile ${n.pixel} of 190 on the route from Peterston Tea Estate to the Cutty Sark.`
    : `Thank you, ${n.name}. Your ${gbp} donation to the Run TeaTrade 190-mile run is confirmed.`;
  const charity = "100% goes to Alzheimer's Research UK and the UK Tea Trade Benevolent Society. Your payment was processed securely by GiveWheel.";
  const updates = n.opt_in
    ? "You asked for occasional updates on the run. They'll come from this address and every one has an unsubscribe link."
    : "";
  const link = `${SITE}/#map-section`;

  const text = [
    headline, "", lead,
    n.message ? `\nYour message: "${n.message}"` : "",
    "", charity,
    isMile ? `\nSee your mile on the map: ${link}` : `\nFollow the run: ${link}`,
    updates ? `\n${updates}` : "",
    "\nThank you for backing the run.\nRob",
    "\nYou're receiving this because you donated at run.teatrade.co.uk. Just reply if you have a question.",
  ].filter(s => s !== "").join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f6f6f6;font-family:Roboto,Arial,sans-serif;color:#202124;">
<div style="max-width:520px;margin:0 auto;padding:24px 16px;">
  <div style="background:#ffffff;border-radius:14px;padding:28px 26px;border:1px solid #e6e6e6;">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#f56600;font-weight:600;">Run TeaTrade · 190 miles</div>
    <h1 style="font-size:26px;line-height:1.2;margin:8px 0 14px;">${esc(headline)}</h1>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${esc(lead)}</p>
    ${n.message ? `<p style="font-size:15px;line-height:1.5;margin:0 0 14px;padding-left:12px;border-left:3px solid #f56600;color:#5f6368;font-style:italic;">&ldquo;${esc(n.message)}&rdquo;</p>` : ""}
    <p style="font-size:14px;line-height:1.55;margin:0 0 20px;color:#5f6368;">${esc(charity)}</p>
    <p style="margin:0 0 20px;"><a href="${link}" style="display:inline-block;background:#f56600;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px;font-size:15px;">${isMile ? "See your mile on the map" : "Follow the run"}</a></p>
    ${updates ? `<p style="font-size:13px;line-height:1.5;margin:0 0 16px;color:#5f6368;">${esc(updates)}</p>` : ""}
    <p style="font-size:15px;margin:0;">Thank you for backing the run.<br>Rob</p>
  </div>
  <p style="font-size:12px;line-height:1.5;color:#8a8d91;margin:14px 6px 0;">You're receiving this because you donated at run.teatrade.co.uk. Just reply to this email if you have a question.</p>
</div></body></html>`;

  return { subject, html, text };
}

async function resend(env, path, { method = "POST", body, idempotencyKey } = {}) {
  const headers = {
    "authorization": `Bearer ${env.RESEND_API_KEY}`,
    "content-type":  "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return fetch(`${API}${path}`, {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function sendConfirmation(env, n) {
  const { subject, html, text } = buildConfirmation(n);
  const payload = {
    from: env.RESEND_FROM || DEFAULT_FROM,
    to: [n.email], subject, html, text,
  };
  if (env.RESEND_REPLY_TO) payload.reply_to = env.RESEND_REPLY_TO;
  const r = await resend(env, "/emails", { body: payload, idempotencyKey: `confirm-${n.gw_id}` });
  if (!r.ok) console.error("resend_confirmation_failed", r.status, (await r.text()).slice(0, 200));
}

// Subscribes the donor to the run-updates Topic only. Creating the contact
// fails if they already exist (e.g. they're on the main TeaTrade list), so
// fall back to updating their topic subscriptions.
async function subscribeToUpdates(env, n) {
  if (!env.RESEND_TOPIC_ID) return;
  const topic = [{ id: env.RESEND_TOPIC_ID, subscription: "opt_in" }];
  const created = await resend(env, "/contacts", {
    body: { email: n.email, first_name: String(n.name || "").slice(0, 50), unsubscribed: false, topics: topic },
  });
  if (created.ok) return;
  if (created.status >= 500 || created.status === 429) {
    console.error("resend_contact_failed", created.status);
    return;
  }
  const updated = await resend(env, `/contacts/${encodeURIComponent(n.email)}/topics`, { method: "PATCH", body: topic });
  if (!updated.ok) console.error("resend_topic_update_failed", updated.status, (await updated.text()).slice(0, 200));
}

export async function notifyDonor(env, n) {
  if (!env.RESEND_API_KEY || !n?.email) return;
  try { await sendConfirmation(env, n); }
  catch (e) { console.error("resend_confirmation_error", String(e && e.message || e)); }
  if (n.opt_in) {
    try { await subscribeToUpdates(env, n); }
    catch (e) { console.error("resend_subscribe_error", String(e && e.message || e)); }
  }
}

export function notifyAll(env, notifications) {
  return Promise.allSettled(notifications.map(n => notifyDonor(env, n)));
}
