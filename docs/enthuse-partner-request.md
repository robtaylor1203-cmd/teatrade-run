# Enthuse partner-API request — draft email

**To:** `partners@enthuse.com` (cc your contact at Alzheimer's Society if
they introduced you)
**Subject:** Custom-field webhook access for charity-run microsite (Alzheimer's Society + UKTTBS)

---

Hi Enthuse team,

I'm running a sponsored ultra in April 2027 — 190 miles from Peterston
Tea Estate in Wales to the Cutty Sark in London — split 50/50 between
**Alzheimer's Society UK** and the **UK Tea Trade Benevolent Society**.

The campaign sits at **`run.teatrade.co.uk`** and has a "Sponsor a Mile"
mechanic: each of the 190 miles can be sponsored individually (£50
standard, £100 premium, £250 start/finish). When a donation lands I'd
like the corresponding pixel on the route map to update automatically
with the donor's name, message and (optionally) company logo.

To do that I need three things, all of which I believe Enthuse offers
to partners:

1. **A campaign page** on Enthuse, fundraising for the two charities
   above (50/50 split), with pre-set donation amounts of £50, £100 and
   £250. Custom amounts also welcome.
2. **Custom donation fields** the donor's flow carries through:
   - `claim_id` (string, hidden) — token I generate on my site
   - `mile` (string) — which mile they're sponsoring
   - `tier` (string) — `standard` / `featured` / `premium`
   - `donor_type` (string) — `individual` / `corporate`
3. **Webhook delivery** on `donation.completed`, posting to
   `https://run.teatrade.co.uk/api/enthuse-webhook`, with the custom
   fields included in the payload and an HMAC-SHA256 signature header
   so I can verify authenticity.

If any of those aren't possible exactly as described, I'd love to talk
through the closest alternative — the goal is simply to confirm a
donation against a pixel reservation in seconds rather than reconciling
manually after the fact.

I'm happy to share the test microsite, donation amounts, and projected
volume (couple of hundred donations across launch and run-day).

Thanks very much,
Rob Taylor
TeaTrade
[email] · [phone]
