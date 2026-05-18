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

    // 4. Add to your pending list and save
    if (!data.pending) data.pending = [];
    data.pending = data.pending.filter(p => p.pixel !== pixel); // clear old locks
    data.pending.push({
      pixel: pixel,
      code: lockCode,
      expiresAt: Date.now() + (15 * 60 * 1000), // 15 mins
      sponsor_name: body.sponsor_name,
      message: body.message,
      tier: body.tier,
      amount: body.tier === 'corporate' ? 50 : 20
    });
    await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));

    // 5. Send them to Ollie's exact GiveWheel URL!
    const baseUrl = "https://www.givewheel.com/fundraising/16454/run-teatrade/";
    return Response.json({
      GiveWheel_url: `${baseUrl}?checkout=true&d_question_1=${lockCode}`,
      code: lockCode 
    });

  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}