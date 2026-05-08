# teatrade-run

Single-page charity-run microsite for `run.teatrade.co.uk` — 190 miles from
Peterston Tea Estate (Wales) to the Cutty Sark (London) in support of
**Alzheimer's Society UK** and the **UK Tea Trade Benevolent Society**.

## Donation flow (Enthuse + Cloudflare Pages)

The site never touches money. Donations are taken on **Enthuse**, which
remits to the two charities directly. Sponsor pixels on the map sync to
real donations via an Enthuse webhook.

```
visitor clicks mile
        │
        ▼
sponsor form (donor type, name, message, optional logo)
        │   POST /api/claim
        ▼
Cloudflare Function reserves the pixel as `pending`
        │   returns enthuse_url with ?claim_id=…
        ▼
visitor donates on Enthuse
        │
        ▼
Enthuse fires webhook → /api/enthuse-webhook
        │   verifies HMAC, finds pending claim, confirms
        ▼
sponsorships.json (in KV) is updated
        │
        ▼
front-end polls /api/sponsorships every 30s →
pixel turns orange / blue / black, total raised animates up
```

### Required environment variables (Cloudflare Pages → Settings → Environment variables)

| Name | Description |
|---|---|
| `ENTHUSE_CAMPAIGN_URL`   | Public URL of your Enthuse campaign donation page. |
| `ENTHUSE_WEBHOOK_SECRET` | HMAC secret shared with Enthuse for webhook verification. |
| `PENDING_TTL_MIN`        | Optional. Minutes a pending claim is held (default 30). |
| `CLOUDINARY_CLOUD_NAME`  | For unsigned logo uploads (set in `index.html` config block). |
| `CLOUDINARY_UPLOAD_PRESET` | Cloudinary unsigned preset name. |

### Required Cloudflare KV binding

Bind a KV namespace called `SPONSORSHIPS_KV` to the Pages project. The
functions read and write a single key, `data`, holding the JSON shape
documented in [`sponsorships.json`](sponsorships.json).

To bootstrap the namespace from the committed file:

```powershell
wrangler kv key put --binding=SPONSORSHIPS_KV "data" --path=sponsorships.json
```

### Required Enthuse setup

Email Enthuse partner support (template in
[`docs/enthuse-partner-request.md`](docs/enthuse-partner-request.md)) and
ask for:

1. A campaign on your behalf (or under one of the charities) with
   pre-set amounts of £50 / £100 / £250.
2. **Custom donation fields** (`claim_id`, `mile`, `tier`, `donor_type`).
3. **Webhook access** for `donation.completed`, posting to
   `https://run.teatrade.co.uk/api/enthuse-webhook` with HMAC-SHA256
   signature header `x-enthuse-signature`.

### Local dev

```powershell
npm i -g wrangler
wrangler pages dev . --kv SPONSORSHIPS_KV
```

The static site lives at `/index.html`. Functions live under `/functions/api/`.

### Deployment

Push to `main`; Cloudflare Pages auto-builds and deploys.
