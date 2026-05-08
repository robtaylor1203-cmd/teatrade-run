/**
 * POST /api/donate
 * --------------------------------------------------------------
 * "Donate any amount" — generic donation that does NOT claim a
 * specific mile. Same fields as /api/claim but no pixel, no tier,
 * no logo. Records the donor's chosen amount as a pending entry
 * keyed by claim_id, then redirects to Enthuse. The webhook
 * handler matches on claim_id, credits raised_total, and stores
 * a public-facing entry in `general_donations[]` (so we can list
 * names on a "supporters" wall later if you want).
 *
 * Min donation enforced server-side: £1.
 */
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const {
    amount,         // GBP, integer pounds
    donor_type,     // "individual" | "corporate"
    sponsor_name,
    message,
    contact_email,
  } = body || {};

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 1 || amt > 100000) {
    return json({ error: "bad_amount" }, 400);
  }
  if (!sponsor_name || sponsor_name.length > 80) {
    return json({ error: "bad_name" }, 400);
  }
  if (donor_type !== "individual" && donor_type !== "corporate") {
    return json({ error: "bad_donor_type" }, 400);
  }
  if (message && message.length > 200) {
    return json({ error: "message_too_long" }, 400);
  }

  const data = await readSponsorships(env);
  data.general_pending = data.general_pending || [];

  const claim_id = "g_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  data.general_pending.push({
    claim_id,
    amount: Math.round(amt),
    donor_type,
    sponsor_name,
    message: message || "",
    contact_email: contact_email || null,
    created_ms: Date.now(),
  });

  // Trim old pending entries (TTL — same as pixel claims).
  const ttlMs = Number(env.PENDING_TTL_MIN || 30) * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  data.general_pending = data.general_pending.filter(p => p.created_ms > cutoff);

  await writeSponsorships(env, data);

  const url = new URL(env.ENTHUSE_CAMPAIGN_URL);
  url.searchParams.set("amount", String(Math.round(amt)));
  url.searchParams.set("claim_id", claim_id);
  url.searchParams.set("ref", "general");
  url.searchParams.set("custom_donor_type", donor_type);

  return json({ claim_id, enthuse_url: url.toString() });
}

async function readSponsorships(env) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  if (!raw) {
    return {
      sponsorships:    [],
      pending:         [],
      general_pending: [],
      raised_total:    0,
      raised_goal:     19000,
    };
  }
  return JSON.parse(raw);
}

async function writeSponsorships(env, data) {
  data.updated = new Date().toISOString();
  await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
