export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const pixel = parseInt(body.pixel);
    
    if (!pixel || pixel < 1 || pixel > 190) {
      return Response.json({ error: "invalid_pixel" }, { status: 400 });
    }

    // 1. Get your existing database blob
    const raw = await env.SPONSORSHIPS_KV.get("data");
    let data = raw ? JSON.parse(raw) : { sponsorships: [], pending: [] };

    // 2. Check if already claimed or safely locked
    if (data.sponsorships && data.sponsorships.some(s => s.pixel === pixel)) {
      return Response.json({ error: "already_claimed" }, { status: 400 });
    }
    if (data.pending && data.pending.some(p => p.pixel === pixel && Date.now() < p.expiresAt)) {
      return Response.json({ error: "pending" }, { status: 400 });
    }

    // 3. Generate the unique code
    const lockCode = `M${pixel}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // 4. Capture the dynamic amount from the frontend (50, 100, or 250)
    const donationAmount = parseInt(body.amount) || 50;

    // 5. Add to your pending list and save
    if (!data.pending) data.pending = [];
    data.pending = data.pending.filter(p => p.pixel !== pixel); // clear old locks
    const nowMs = Date.now();
    data.pending.push({
      pixel: pixel,
      code: lockCode,
      claim_id: lockCode,
      created_ms: nowMs,
      expiresAt: nowMs + (30 * 60 * 1000), // 30 mins lock
      sponsor_name: body.sponsor_name,
      donor_type: body.donor_type || "individual",
      message: body.message,
      tier: body.tier,
      amount: donationAmount,
      logo_url: body.logo_url || null
    });
    await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

    // 6. Safely encode the Name and Message so they don't break the URL
    const safeName = encodeURIComponent(body.sponsor_name || "Anonymous");
    const safeMessage = encodeURIComponent(body.message || "");

    // 7. Send them to GiveWheel's checkout URL with all parameters attached.
    //    Per Ollie: param is `donation` (not `amount`), and `lock_amount=true`
    //    prevents the donor changing it on the GW page (so our amount-based
    //    matching stays sound). Questions: 1 = lock code, 2 = name, 3 = message.
    const baseUrl = "https://www.givewheel.com/fundraising/16454/run-teatrade/";
    const giveWheelUrl = `${baseUrl}?checkout=true&donation=${donationAmount}&lock_amount=true&d_question_1=${lockCode}&d_question_2=${safeName}&d_question_3=${safeMessage}`;

    return Response.json({
      GiveWheel_url: giveWheelUrl,
      code: lockCode 
    });

  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}