export async function onRequestGet({ env }) {
  // 1. Fetch your existing database
  const raw = await env.SPONSORSHIPS_KV.get("data");
  let data = raw ? JSON.parse(raw) : { sponsorships: [], raised_total: 0, raised_goal: 19000, updated: null, pending: [] };

  // 2. Check Ollie's GiveWheel API for payments
  try {
    const gwRes = await fetch("https://www.givewheel.com/api/fundraisings/16454/donations/");
    if (gwRes.ok) {
      const gwData = await gwRes.json();
      const gwString = JSON.stringify(gwData); 

      if (data.pending && data.pending.length > 0) {
        let databaseChanged = false;
        
        // Filter pending: If paid, move to sponsorships. If expired, delete.
        data.pending = data.pending.filter(p => {
          if (gwString.includes(p.code)) {
            // GiveWheel saw the code! Move it to confirmed sponsorships.
            if(!data.sponsorships) data.sponsorships = [];
            data.sponsorships.push({
              pixel: p.pixel,
              sponsor: p.sponsor_name,
              initials: "",
              logo: "",
              logoBg: "#ea580c", // Make it orange
              amount: p.amount,
              tier: p.tier,
              message: p.message
            });
            data.raised_total += p.amount;
            databaseChanged = true;
            return false; // Remove from pending list
          }
          if (Date.now() > p.expiresAt) {
            databaseChanged = true;
            return false; // Expired, remove from pending list
          }
          return true; // Still waiting, keep in pending list
        });

        if (databaseChanged) {
          data.updated = new Date().toISOString();
          await env.SPONSORSHIPS_KV.put("data", JSON.stringify(data));
        }
      }
    }
  } catch(e) {
    // If GiveWheel is slow, just ignore and return what we have below
  }

  // 3. Return the exact format your frontend is currently looking for
  return new Response(JSON.stringify({
    updated:      data.updated,
    raised_total: data.raised_total || 0,
    raised_goal:  data.raised_goal  || 19000,
    sponsorships: (data.sponsorships || []).map(s => ({
      pixel:    s.pixel,
      sponsor:  s.sponsor,
      initials: s.initials,
      logo:     s.logo,
      logoBg:   s.logoBg,
      amount:   s.amount,
      tier:     s.tier,
      message:  s.message,
    })),
    pending_pixels: (data.pending || []).map(p => p.pixel),
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15",
      "access-control-allow-origin": "*",
    },
  });
}