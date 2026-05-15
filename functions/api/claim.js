export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const pixel = parseInt(body.pixel);
    
    // 1. Basic Validation
    if (!pixel || pixel < 1 || pixel > 190) {
      return Response.json({ error: "invalid_pixel" }, { status: 400 });
    }

    const kv = env.SPONSORSHIPS_KV;
    const key = `pixel:${pixel}`;

    // 2. Check if the mile is already taken or locked
    const existing = await kv.get(key, "json");
    if (existing) {
      if (existing.status === "confirmed") {
        return Response.json({ error: "already_claimed" }, { status: 400 });
      }
      if (existing.status === "pending") {
        // If it's pending, check if the 15-minute lock has expired
        if (Date.now() < existing.expiresAt) {
          return Response.json({ error: "pending" }, { status: 400 });
        }
        // If expired, we just overwrite it below!
      }
    }

    // 3. Generate the unique lock code (e.g., "M42-A7B9")
    const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
    const lockCode = `M${pixel}-${randomChars}`;

    // 4. Save the Pending Lock to the Database
    const pendingRecord = {
      status: "pending",
      code: lockCode,
      expiresAt: Date.now() + (15 * 60 * 1000), // Locks for exactly 15 minutes
      data: {
        pixel: pixel,
        tier: body.tier,
        amount: body.amount,
        donor_type: body.donor_type,
        sponsor_name: body.sponsor_name,
        message: body.message,
        logo_url: body.logo_url,
        contact_email: body.contact_email,
        created_at: new Date().toISOString()
      }
    };

    await kv.put(key, JSON.stringify(pendingRecord));

    // 5. Construct the GiveWheel redirect URL
    // We will use ?reference= as a placeholder until GiveWheel confirms the exact parameter!
    const baseUrl = "https://www.givewheel.com/fundraising/16454/run-teatrade/";
    const giveWheelUrl = `${baseUrl}?reference=${lockCode}`;

    // 6. Send the URL back to the website so it can redirect the donor
    return Response.json({
      GiveWheel_url: giveWheelUrl,
      code: lockCode 
    });

  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}