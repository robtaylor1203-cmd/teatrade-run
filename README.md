# teatrade-run

Single-page charity-run microsite for `run.teatrade.co.uk` — 190 miles from
Peterston Tea Estate (Wales) to the Cutty Sark (London) in support of
**Alzheimer's Research UK** and the **UK Tea Trade Benevolent Society**.

## Donation flow (GiveWheel + Cloudflare Pages)

The site never touches money. Donations are taken on **GiveWheel**; the site
reads GiveWheel's API to confirm payments and lock miles.

```
visitor picks a mile  →  sponsor form (name, message, business logo)
        │  POST /api/claim
        ▼
server prices the mile from its number (£50 / £100 blue every 10th / £250 gold 1 & 190),
holds it 30 min, returns the GiveWheel checkout URL carrying a lock code M{mile}-XXXX
        │
        ▼
visitor pays on GiveWheel (amount locked)
        │
        ▼
GET /api/sponsorships (polled by every visitor, cached 15s at the edge)
  reads GiveWheel's donations API, matches each payment to its claim by lock code,
  and turns the mile into a confirmed sponsorship (name, message, logo, colour)
        │
        ▼
map + grid update within ~45s: orange individual, black business, gold premium
```

- **Safety rules** live in one place: [`functions/_lib/sponsor.js`](functions/_lib/sponsor.js)
  (pricing, matching, sanitising). A payment below the mile's price never locks it,
  a mile can't be double-booked, and anything unmatched becomes an *orphan*.
- **Orphans / manual fixes**: open `/admin/`, enter `ADMIN_SECRET`. Unmatched
  donations are listed there and can be assigned to a mile.
- **"Donate any amount"** uses `/api/donate` with a `g_` code and doesn't lock a mile.
- **Logos** are stored at KV `logo:<code>` and served from `/api/logo/<code>`.
  Unpaid claims' logos expire after 3 days.
- `/api/givewheel-webhook` is optional and disabled unless `GIVEWHEEL_WEBHOOK_SECRET`
  is set. `/api/enthuse-webhook` is a leftover from an earlier design and unused.
- **Donor emails** ([`functions/_lib/email.js`](functions/_lib/email.js)): once a payment is
  confirmed, the donor gets a confirmation from `Run TeaTrade <run@teatrade.co.uk>` via Resend.
  An unticked "send me updates" box subscribes them to a dedicated Resend Topic. The email is
  held privately on the unpaid claim only and removed once the confirmation is sent. Email is
  best-effort: with no `RESEND_API_KEY`, or if Resend is down, donations still confirm.

### Gear auction (sealed-bid, in-house)

Replaces the old Formspree form. Dates and items live in
[`functions/_lib/auction-config.js`](functions/_lib/auction-config.js): bidding closes **28 February 2027,
23:59 GMT**; winners pay and send logos by **7 March 2027, 23:59 GMT**. If you change a date, also change
the page copy in the `#gear` section of `index.html` and the bid modal.

```
visitor bids (company, email, amount >= item minimum)  ->  POST /api/auction/bid
   emailed a "confirm your bid" link (a bid only counts once confirmed; the button is a POST so
   mail scanners that open links can't confirm it)  ->  receipt email with item + amount
close + 2 min  ->  highest confirmed bid per item wins (ties: earliest confirmation)
   winner emailed a personal GiveWheel link (amount locked, code G{item}-XXXX)
   everyone else gets a courteous result email; organiser gets a summary at contact@
winner pays on GiveWheel  ->  next poll matches the code  ->  card shows "Sponsored by X",
   thank-you email, organiser notified.  Reminders 3 days and 1 day before the deadline;
   an unpaid offer lapses after 7 March and the organiser is emailed.
```

- **Sealed:** nobody is ever told their rank, whether they lead, or that they were outbid. Public
  `/api/auction` returns only open / closed / sponsored per card, never bids.
- **Admin:** `/admin/` > "Gear auction" lists every confirmed bid, shows results, offers an item to
  another bidder (e.g. after a lapse) and exports CSV. Needs `ADMIN_SECRET`.
- **Storage:** the existing KV namespace (one key per bid, so no lost updates); nothing new to set up.
- **Abuse limits** protect the Resend quota shared with the main site: 8 submissions/hour per network
  address, 5/day per email address, 60 verification emails/day overall. Resend's free plan allows 100
  emails/day for the whole account, so consider Pro for launch week.
- Winners reply to their email with logo files (vector PDF/SVG/AI or high-res PNG); replies go to
  `contact@teatrade.co.uk`.

### Cloudflare Pages settings

KV binding: `SPONSORSHIPS_KV`.

| Variable | Purpose |
|---|---|
| `GIVEWHEEL_USERNAME` / `GIVEWHEEL_PASSWORD` | GiveWheel login used to mint and auto-refresh API tokens (password as Secret). **Required** for mile confirmation. |
| `ADMIN_SECRET` | Unlocks `/admin/` and the admin-only fields of `/api/sponsorships`. |
| `GIVEWHEEL_WEBHOOK_SECRET` | Optional. Enables the signed webhook for instant attribution. |
| `RESEND_API_KEY` | Optional (Secret). Enables donor emails. |
| `RESEND_TOPIC_ID` | Resend Topic for run updates. Create it with default subscription **Opt-out** so only people who tick the box ever receive run updates (an Opt-in topic would reach your whole contact list). |
| `RESEND_FROM`, `RESEND_REPLY_TO` | Optional. Default sender is `Run TeaTrade <run@teatrade.co.uk>`. |

**Setting secrets from a file instead of the dashboard.** Pages can't read an env file at
runtime, and this repo is public, so values must never be committed. Instead, fill in the
gitignored `.dev.vars`, run `npx wrangler login` once, then `.\tools\push-secrets.ps1`. It
uploads each filled-in value to Cloudflare as an encrypted secret (anything left as
`PASTE_HERE` is skipped). Secrets apply from the next deployment.
| `GIVEWHEEL_FUNDRAISING_ID`, `GIVEWHEEL_SHORTLINK`, `GIVEWHEEL_SLUG`, `GIVEWHEEL_API_TOKEN` | Optional overrides. |

Bootstrap an empty store (only needed for a brand-new KV namespace):

```powershell
wrangler kv key put --binding=SPONSORSHIPS_KV "data" --path=sponsorships.json
```

### Testing

```powershell
node tools/acid-test.mjs
```

Runs the real functions against a mock KV and mock GiveWheel (claim → pay →
confirm, underpayment, double-booking, XSS, abuse limits, caching). No network,
no real payments. Run it after any change to `functions/`.

Before launch, also make one real £50 test donation end to end.

### Deployment

Push to `main`; Cloudflare Pages auto-builds and deploys. No build step.
