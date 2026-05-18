export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const {
    amount,
    donor_type,
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

  // 1. Generate the unique ID to track this donation
  const claim_id = "g_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  
  // 2. Save to your local database (for the sweep later)
  const data = await readSponsorships(env);
  data.general_pending = data.general_pending || [];
  data.general_pending.push({
    claim_id,
    amount: Math.round(amt),
    donor_type,
    sponsor_name,
    message: message || "",
    contact_email: contact_email || null,
    created_ms: Date.now(),
  });
  await writeSponsorships(env, data);

  // 3. Build the GiveWheel URL using Ollie's parameters
  // We pass the claim_id into d_question_1 so our sweeper can find it!
  const baseUrl = "https://www.givewheel.com/fundraising/16454/run-teatrade/";
  const giveWheelUrl = `${baseUrl}?checkout=true&d_question_1=${claim_id}`;

  return json({ claim_id, GiveWheel_url: giveWheelUrl });
}

async function readSponsorships(env) {
  const raw = await env.SPONSORSHIPS_KV.get("data");
  return raw ? JSON.parse(raw) : { sponsorships: [], pending: [], general_pending: [], raised_total: 0 };
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