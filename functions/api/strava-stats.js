/**
 * GET /api/strava-stats
 * --------------------------------------------------------------
 * Aggregates the runner's activities since `STRAVA_SINCE` and
 * returns the same shape the front-end already expects in
 * `./strava-stats.json`:
 *
 *   {
 *     since:                "2026-01-01",
 *     distance_miles:       42.7,
 *     moving_time_seconds:  20580,
 *     elevation_gain_feet:  1230,
 *     run_count:            8,
 *     athlete_url:          "https://www.strava.com/athletes/12345"
 *   }
 *
 * Strava issues short-lived access tokens (6h) and a long-lived
 * refresh token. We cache both in KV so we only re-authenticate
 * when the access token is about to expire. We cache the final
 * aggregate for 5 minutes to stay well under Strava's rate limits
 * (100 requests / 15 min, 1000 / day).
 *
 * Required env bindings (Cloudflare Pages → Settings → Env vars):
 *   STRAVA_CLIENT_ID         from your Strava API app
 *   STRAVA_CLIENT_SECRET     from your Strava API app
 *   STRAVA_REFRESH_TOKEN     one-time bootstrap (see /tools/strava-auth.html)
 *   STRAVA_ATHLETE_ID        your numeric Strava athlete id (for the profile link)
 *   STRAVA_SINCE             ISO date e.g. "2026-01-01" — only count runs after this
 *   SPONSORSHIPS_KV          re-used to cache token + result (no extra binding needed)
 */
export async function onRequestGet({ env }) {
  try {
    const since = env.STRAVA_SINCE || "2026-01-01";
    const cacheKey = "strava:cache";
    const cached = await env.SPONSORSHIPS_KV.get(cacheKey, { type: "json" });
    if (cached && Date.now() - cached.cached_ms < 5 * 60 * 1000) {
      return json(cached.payload);
    }

    const access = await getAccessToken(env);
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);

    // Page through activities (Strava returns max 200 per page).
    const all = [];
    for (let page = 1; page < 10; page++) {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${sinceEpoch}&per_page=200&page=${page}`,
        { headers: { authorization: `Bearer ${access}` } },
      );
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 200) break;
    }

    // Filter to runs only and aggregate.
    const runs = all.filter(a =>
      a.type === "Run" || a.sport_type === "Run" || a.sport_type === "TrailRun");
    const meters = runs.reduce((s, r) => s + (r.distance || 0), 0);
    const seconds = runs.reduce((s, r) => s + (r.moving_time || 0), 0);
    const elevM   = runs.reduce((s, r) => s + (r.total_elevation_gain || 0), 0);

    const payload = {
      since,
      distance_miles:      +(meters / 1609.344).toFixed(1),
      moving_time_seconds: seconds,
      elevation_gain_feet: Math.round(elevM * 3.28084),
      run_count:           runs.length,
      athlete_url:         env.STRAVA_ATHLETE_ID
                             ? `https://www.strava.com/athletes/${env.STRAVA_ATHLETE_ID}`
                             : "https://www.strava.com",
    };

    await env.SPONSORSHIPS_KV.put(
      cacheKey,
      JSON.stringify({ cached_ms: Date.now(), payload }),
      { expirationTtl: 60 * 10 },
    );

    return json(payload);
  } catch (err) {
    return json({ error: "strava_unavailable", detail: String(err) }, 502);
  }
}

async function getAccessToken(env) {
  // Cached access token (valid up to 6h). KV stores { token, expires_at }.
  const tokKey = "strava:token";
  const tok = await env.SPONSORSHIPS_KV.get(tokKey, { type: "json" });
  if (tok && tok.expires_at > Math.floor(Date.now() / 1000) + 60) {
    return tok.token;
  }
  // Strava rotates the refresh token on each refresh. Prefer the
  // KV-stashed one (newest), falling back to the env var bootstrap.
  const refreshToken =
    (await env.SPONSORSHIPS_KV.get("strava:refresh")) ||
    env.STRAVA_REFRESH_TOKEN;
  // Refresh.
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!r.ok) throw new Error("strava refresh failed: " + r.status);
  const data = await r.json();
  await env.SPONSORSHIPS_KV.put(
    tokKey,
    JSON.stringify({ token: data.access_token, expires_at: data.expires_at }),
    { expirationTtl: 6 * 60 * 60 },
  );
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await env.SPONSORSHIPS_KV.put("strava:refresh", data.refresh_token);
  }
  return data.access_token;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}
