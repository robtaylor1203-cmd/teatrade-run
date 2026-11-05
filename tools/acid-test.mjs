// Run: node tools/acid-test.mjs   (no deps, no network, no real payments)
// Runs the real Cloudflare Function modules against a mock KV and a mock
// GiveWheel API (response shapes copied from production). The functions are
// copied to a temp folder marked as ESM so the repo needs no package.json.
import { cpSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "teatrade-acid-"));
cpSync(join(dirname(fileURLToPath(import.meta.url)), "..", "functions"), join(tmp, "functions"), { recursive: true });
writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
const load = (p) => import(pathToFileURL(join(tmp, "functions", p)).href);

const { onRequestPost: claim }       = await load("api/claim.js");
const { onRequestPost: donate }      = await load("api/donate.js");
const { onRequestGet:  poll }        = await load("api/sponsorships.js");
const { onRequestGet:  logoGet }     = await load("api/logo/[id].js");
const { onRequestPost: webhook }     = await load("api/givewheel-webhook.js");
const { onRequestPost: adminAssign } = await load("api/admin/assign-pixel.js");
const { milePrice, mileTier }        = await load("_lib/sponsor.js");
const { onRequestGet: auctionStatus }                       = await load("api/auction.js");
const { onRequestPost: auctionBid }                         = await load("api/auction/bid.js");
const { onRequestGet: confirmGet, onRequestPost: confirmPost } = await load("api/auction/confirm.js");
const { onRequestGet: adminAuctionGet, onRequestPost: adminAuctionPost } = await load("api/admin/auction.js");
const { tick: auctionTick, listBids } = await load("_lib/auction.js");
const { ITEMS, AUCTION_CLOSES_MS, PAY_BY_MS } = await load("_lib/auction-config.js");
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  PASS", label); }
  else      { fail++; console.log("  FAIL", label, extra !== undefined ? JSON.stringify(extra) : ""); }
};

// ---- mock KV --------------------------------------------------------
class KV {
  constructor() { this.m = new Map(); }
  async get(k, opts) {
    const e = this.m.get(k);
    if (!e) return null;
    return opts?.type === "json" ? JSON.parse(e.v) : e.v;
  }
  async put(k, v, opts) { this.m.set(k, { v: String(v), ttl: opts?.expirationTtl ?? null, meta: opts?.metadata ?? null }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const names = [...this.m.keys()].filter(k => k.startsWith(prefix)).sort();
    const keys = names.map(name => ({ name, metadata: this.m.get(name).meta ?? undefined }));
    return { keys, list_complete: true };
  }
  ttl(k) { return this.m.get(k)?.ttl; }
}

// ---- mock GiveWheel -------------------------------------------------
const gwDonations = [];
let gwId = 462900;
let gwCalls = 0;
function gwPay({ amount, code, name = "Donor", message = "" }) {
  gwDonations.push({
    id: ++gwId, donationamount: amount.toFixed(2), donation_original_currency: amount.toFixed(2),
    currency_iso: "GBP", transaction_date: new Date().toISOString(), Name: name, Message: message,
    supporter_questions: code ? [{ question_id: 9, question: "Sponsored Mile", response: code }] : [],
  });
  return gwId;
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com")) return resendMock(u, init);
  gwCalls++;
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.includes("/api/fundraisings/url/")) {
    return res(200, { id: 16454, amount_raised: gwDonations.reduce((a, d) => a + parseFloat(d.donationamount), 0), supporters: gwDonations.length });
  }
  if (u.endsWith("/api/auth/login/")) {
    return res(200, { token: "tok1", expiry: new Date(Date.now() + 10 * 3600e3).toISOString() });
  }
  if (u.endsWith("/api/fundraisings/16454/donations/")) {
    if (init.headers?.authorization !== "Token tok1") return res(401, { detail: "Invalid token" });
    return res(200, gwDonations);
  }
  return res(404, {});
};

// ---- mock Resend ----------------------------------------------------
const resendCalls = [];
const sentKeys = new Set();
const allEmails = [];   // every email body ever sent, for house-rule checks
const existingContacts = new Set();
let resendMode = "ok";   // "ok" | "down" | "ratelimit_once"
let rateLimited = false;
function resendMock(u, init) {
  const path = u.replace("https://api.resend.com", "");
  const body = init.body ? JSON.parse(init.body) : null;
  const call = { path, method: init.method || "GET", headers: init.headers, body };
  resendCalls.push(call);
  const res = (status, b, h = {}) => new Response(JSON.stringify(b), { status, headers: h });
  if (init.headers?.authorization !== "Bearer re_test") return res(401, { message: "bad key" });
  if (resendMode === "down") return res(500, { message: "down" });
  if (resendMode === "ratelimit_once" && !rateLimited) { rateLimited = true; return res(429, { message: "slow down" }, { "retry-after": "0" }); }
  if (path === "/emails") {
    const k = init.headers["idempotency-key"];
    if (k) sentKeys.add(k);
    allEmails.push(body);
    return res(200, { id: "em_" + resendCalls.length });
  }
  if (path === "/contacts") {
    if (existingContacts.has(body.email)) return res(409, { message: "exists" });
    existingContacts.add(body.email);
    return res(200, { id: "ct_1" });
  }
  const one = /^\/contacts\/([^/]+)$/.exec(path);
  if (one && call.method === "GET") {
    return existingContacts.has(decodeURIComponent(one[1])) ? res(200, { object: "contact" }) : res(404, { name: "not_found" });
  }
  if (/^\/contacts\/.+\/topics$/.test(path)) {
    return Array.isArray(body) ? res(200, { object: "contact_topics" }) : res(422, { message: "body must be an array" });
  }
  return res(404, {});
}

// ---- helpers --------------------------------------------------------
const kv = new KV();
const env = {
  SPONSORSHIPS_KV: kv, GIVEWHEEL_USERNAME: "u@x", GIVEWHEEL_PASSWORD: "pw",
  ADMIN_SECRET: "adm", GIVEWHEEL_WEBHOOK_SECRET: "whsec",
  RESEND_API_KEY: "re_test", RESEND_TOPIC_ID: "topic_run", RESEND_GAP_MS: "0",
};
const bg = [];
const makeCtx = (request) => ({ request, env, waitUntil: p => bg.push(p) });
const flush = async () => { await Promise.allSettled(bg.splice(0)); };
const post = (path, body, headers = {}) => new Request("https://run.teatrade.co.uk" + path,
  { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const doClaim = async (body, ip = "1.1.1.1") => {
  const r = await claim(makeCtx(post("/api/claim", body, { "cf-connecting-ip": ip })));
  return { status: r.status, body: await r.json() };
};
const doPoll = async (admin = false) => {
  const r = await poll(makeCtx(new Request("https://run.teatrade.co.uk/api/sponsorships?t=1",
    { headers: admin ? { "x-admin-secret": "adm" } : {} })));
  return r.json();
};
const codeFrom = (url) => new URL(url).searchParams.get("d_question_1");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// =====================================================================
console.log("\n1. Pricing is decided by the server");
ok(milePrice(63) === 50 && mileTier(63) === "standard", "mile 63 = standard Â£50");
ok(milePrice(20) === 100 && mileTier(20) === "featured", "mile 20 = featured Â£100");
ok(milePrice(1) === 250 && milePrice(190) === 250 && mileTier(190) === "premium", "miles 1 & 190 = premium Â£250");

console.log("\n2. Claim validation / abuse");
let r = await doClaim({ pixel: 63, amount: 1, sponsor_name: "Cheat", donor_type: "individual" });
ok(r.status === 400 && r.body.error === "bad_amount", "claiming a Â£50 mile for Â£1 is refused", r);
r = await doClaim({ pixel: 0, amount: 50, sponsor_name: "x" });
ok(r.status === 400 && r.body.error === "invalid_pixel", "pixel 0 refused");
r = await doClaim({ pixel: 191, amount: 50, sponsor_name: "x" });
ok(r.status === 400, "pixel 191 refused");
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: "   " });
ok(r.status === 400 && r.body.error === "bad_name", "blank name refused");
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: "Biz", donor_type: "corporate", logo_url: "javascript:alert(1)" });
ok(r.status === 400 && r.body.error === "bad_logo", "javascript: logo refused");
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: "Biz", donor_type: "corporate", logo_url: "https://evil.example/x.png" });
ok(r.status === 400 && r.body.error === "bad_logo", "remote https logo refused on public claim");

console.log("\n3. Happy path: individual claims mile 63 with an XSS-y name");
const xss = `<img src=x onerror=alert(1)>Jane`;
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: xss, message: "Go <b>Rob</b>!", donor_type: "individual", client_token: "tokenAAAA1111" }, "2.2.2.2");
ok(r.status === 200 && r.body.GiveWheel_url, "claim accepted", r);
const url63 = new URL(r.body.GiveWheel_url);
const code63 = r.body.code;
ok(url63.searchParams.get("donation") === "50", "GW url uses donation=50", url63.search);
ok(url63.searchParams.get("lock_amount") === "true", "GW url locks the amount");
ok(/^M63-[A-Z0-9]{4}$/.test(code63), "lock code format M63-XXXX", code63);
let pub = await doPoll();
ok(pub.pending_pixels.includes(63), "mile 63 shows as reserved");
ok(pub.sponsorships.length === 0, "not sponsored until paid");
ok(!("_diag" in pub) && !("orphan_donations" in pub), "public response has NO diagnostics / donor records");

console.log("\n4. Contention");
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: "Rival" }, "3.3.3.3");
ok(r.status === 409 && r.body.error === "pending", "another visitor can't take a reserved mile", r);
r = await doClaim({ pixel: 63, amount: 50, sponsor_name: "Jane retry", client_token: "tokenAAAA1111" }, "2.2.2.2");
ok(r.status === 200, "same browser can retry after bouncing back from checkout", r);
const code63b = r.body.code;
ok(code63b !== code63, "retry issues a fresh code");

console.log("\n5. Donor pays on GiveWheel -> poll confirms the mile");
gwPay({ amount: 50, code: code63b, name: "Jane GW", message: "typed on GW" });
pub = await doPoll();
let s = pub.sponsorships.find(x => x.pixel === 63);
ok(!!s, "mile 63 is now sponsored", pub.sponsorships);
ok(s && s.sponsor === "Jane retry", "name comes from our claim");
ok(pub.raised_total === 50, "raised_total from GiveWheel = 50", pub.raised_total);
ok(!pub.pending_pixels.includes(63), "reservation cleared");
ok(s && s.logoBg === "#f56600" && s.donor_type === "individual", "individual standard = orange");
// old code arriving later must not double-book
gwPay({ amount: 50, code: code63 });
pub = await doPoll(true);
ok(pub.sponsorships.filter(x => x.pixel === 63).length === 1, "no duplicate sponsorship rows for mile 63");
ok(pub.orphan_donations.some(o => o.reason === "pixel_taken"), "second payment for a taken mile is flagged for admin, money still counted", pub.orphan_donations);
ok(pub._diag && pub._diag.donations_ok === true, "admin sees diagnostics");

console.log("\n6. Business, premium mile 190, uploads a logo");
r = await doClaim({ pixel: 190, amount: 250, sponsor_name: "Peterston Tea", donor_type: "corporate", message: "Finish strong", logo_url: PNG, client_token: "tokenBBBB2222" }, "4.4.4.4");
ok(r.status === 200, "premium corporate claim w/ logo accepted", r);
const code190 = r.body.code;
ok(kv.ttl(`logo:${code190}`) > 0, "unpaid logo has an expiry so abandoned claims clean up");
let dd = JSON.parse(await kv.get("data"));
ok(!JSON.stringify(dd).includes("base64"), "main KV document contains no base64 blobs");
gwPay({ amount: 250, code: code190, name: "Peterston" });
pub = await doPoll();
s = pub.sponsorships.find(x => x.pixel === 190);
ok(s && s.tier === "premium" && s.donor_type === "corporate" && s.logoBg === "#202124", "corporate premium = black, tier premium", s);
ok(s && s.logo === `/api/logo/${code190}`, "public record points at /api/logo/<code>", s && s.logo);
ok(kv.ttl(`logo:${code190}`) === null, "logo made permanent once paid");
const lr = await logoGet({ params: { id: code190 }, env });
ok(lr.status === 200 && lr.headers.get("content-type") === "image/png", "logo endpoint serves the image");
ok((lr.headers.get("content-security-policy") || "").includes("sandbox"), "logo endpoint sandboxed");
const lr404 = await logoGet({ params: { id: "../../etc/passwd" }, env });
ok(lr404.status === 404, "logo endpoint rejects path tricks");

console.log("\n7. Underpayment / tampering on GiveWheel");
r = await doClaim({ pixel: 72, amount: 50, sponsor_name: "Skinflint" }, "5.5.5.5");
ok(r.status === 200 && !!r.body.code, "claim for mile 72 issued a code", r);
gwPay({ amount: 1, code: r.body.code, name: "Skinflint" });
pub = await doPoll(true);
ok(!pub.sponsorships.some(x => x.pixel === 72), "Â£1 payment against a Â£50 mile does NOT lock the mile");
ok(pub.orphan_donations.some(o => o.code === r.body.code), "â€¦and is flagged for admin", pub.orphan_donations);

console.log("\n8. Late payer (lock expired, mile still free) keeps their logo + message");
r = await doClaim({ pixel: 71, amount: 50, sponsor_name: "Slowcoach & Co", donor_type: "corporate", message: "Sorry I'm late", logo_url: PNG }, "6.6.6.6");
const code71 = r.body.code;
dd = JSON.parse(await kv.get("data"));
const row = dd.pending.find(p => p.code === code71);
row.created_ms -= 40 * 60e3; row.expiresAt = Date.now() - 10 * 60e3;
await kv.put("data", JSON.stringify(dd));
pub = await doPoll();
ok(!pub.pending_pixels.includes(71), "expired lock frees the mile for others");
gwPay({ amount: 50, code: code71, name: "x" });
pub = await doPoll();
s = pub.sponsorships.find(x => x.pixel === 71);
ok(s && s.sponsor === "Slowcoach & Co" && s.message === "Sorry I'm late" && s.logo === `/api/logo/${code71}`, "late payment still confirmed with logo + message", s);

console.log("\n9. Donate-any-amount");
let dr = await donate(makeCtx(post("/api/donate", { amount: 20, donor_type: "individual", sponsor_name: "Gift", message: "hi" })));
const dj = await dr.json();
const durl = new URL(dj.GiveWheel_url);
ok(dr.status === 200 && durl.searchParams.get("donation") === "20", "uses donation= param (not amount=)", durl.search);
ok(!durl.searchParams.has("lock_amount"), "amount not locked for general gifts");
gwPay({ amount: 35, code: codeFrom(dj.GiveWheel_url), name: "Gift" });   // donor bumped it up
pub = await doPoll(true);
ok(!pub.orphan_donations.some(o => o.amount === 35), "general donation matched even though donor changed the amount", pub.orphan_donations);
dr = await donate(makeCtx(post("/api/donate", { amount: 0, donor_type: "individual", sponsor_name: "x" })));
ok(dr.status === 400, "zero donation refused");

console.log("\n10. Direct GiveWheel donation (no code) -> orphan -> admin assigns");
const gid = gwPay({ amount: 50, name: "Walk-in", message: "found you on LinkedIn" });
pub = await doPoll(true);
ok(pub.orphan_donations.some(o => o.gw_id === String(gid)), "unmatched donation held as orphan");
let ar = await adminAssign(makeCtx(post("/api/admin/assign-pixel", { secret: "wrong", pixel: 80, gw_id: String(gid) })));
ok(ar.status === 403, "admin endpoint rejects wrong secret");
ar = await adminAssign(makeCtx(post("/api/admin/assign-pixel", { secret: "adm", pixel: 80, gw_id: String(gid), logo_url: "javascript:alert(1)", sponsor_name: "Walk-in <script>" })));
const aj = await ar.json();
ok(ar.status === 200 && aj.ok, "admin can assign", aj);
pub = await doPoll(true);
s = pub.sponsorships.find(x => x.pixel === 80);
ok(s && s.logo === "" , "admin logo field sanitised", s);
ok(!pub.orphan_donations.some(o => o.gw_id === String(gid)), "orphan cleared after assignment");

console.log("\n11. Idempotency");
const before = JSON.stringify((await doPoll()).sponsorships);
await doPoll(); await doPoll();
ok(JSON.stringify((await doPoll()).sponsorships) === before, "repeated polls don't change or duplicate anything");

console.log("\n12. Webhook");
const whBody = JSON.stringify({ donation: { id: 999001, amount: 50, name: "Hook", supporter_questions: [{ response: "M121-ZZZZ" }] } });
let wr = await webhook(makeCtx(new Request("https://x/api/givewheel-webhook", { method: "POST", body: whBody })));
ok(wr.status === 401, "unsigned webhook rejected");
const noSecretEnv = { ...env, GIVEWHEEL_WEBHOOK_SECRET: undefined };
wr = await webhook({ request: new Request("https://x/w", { method: "POST", body: whBody }), env: noSecretEnv });
ok(wr.status === 503, "webhook disabled (fail closed) when no secret configured");
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(whBody))).toString("hex");
wr = await webhook(makeCtx(new Request("https://x/w", { method: "POST", body: whBody, headers: { "x-givewheel-signature": sig } })));
const wj = await wr.json();
ok(wr.status === 200 && wj.pixel === 121, "signed webhook attributes via lock code", wj);

console.log("\n13. Abuse: one client can't lock the whole map");
let last;
for (let i = 0; i < 7; i++) last = await doClaim({ pixel: 100 + i + (i > 0 ? 0 : 0) * 0 + 1, amount: milePrice(101 + i), sponsor_name: "Bot" + i }, "9.9.9.9");
ok(last.status === 429, "7th simultaneous reservation from one address refused", last);

console.log("\n14. Edge cache: launch-day polls don't hammer GiveWheel");
const store = new Map();
globalThis.caches = { default: {
  async match(req) { const h = store.get(req.url); return h ? h.clone() : undefined; },
  async put(req, res) { store.set(req.url, res); },
}};
const pending = [];
const cctx = () => ({ request: new Request("https://run.teatrade.co.uk/api/sponsorships?t=" + Math.random()), env, waitUntil: p => pending.push(p) });
gwCalls = 0;
await poll(cctx()); await Promise.all(pending);
const firstCalls = gwCalls;
for (let i = 0; i < 50; i++) await poll(cctx());
ok(firstCalls > 0 && gwCalls === firstCalls, `50 further visitor polls made 0 extra GiveWheel calls (first poll: ${firstCalls})`, gwCalls);
delete globalThis.caches;

console.log("\n15. Donor emails (confirmation + opt-in updates)");
const emails  = () => resendCalls.filter(c => c.path === "/emails");
const subs    = () => resendCalls.filter(c => c.path === "/contacts" || /\/topics$/.test(c.path));
const reset   = () => { resendCalls.length = 0; };
const payFor  = async (claimRes, amount, name) => { gwPay({ amount, code: claimRes.body.code, name }); await doPoll(); await flush(); };

r = await doClaim({ pixel: 41, amount: 50, sponsor_name: "Bad", contact_email: "not-an-email" }, "10.0.0.1");
ok(r.status === 400 && r.body.error === "bad_email", "invalid email rejected on claim", r);
dr = await donate(makeCtx(post("/api/donate", { amount: 5, donor_type: "individual", sponsor_name: "x", contact_email: "a@b" })));
ok(dr.status === 400, "invalid email rejected on donate");

reset();
r = await doClaim({ pixel: 41, amount: 50, sponsor_name: "<b>Anna</b>", message: "Run <i>fast</i>", contact_email: "Anna@Example.com ", updates_opt_in: true }, "10.0.0.2");
ok(r.status === 200, "claim with email + opt-in accepted", r);
await flush();
ok(emails().length === 0, "no email before payment");
pub = await doPoll(true);
ok(!JSON.stringify(pub).includes("example.com"), "email absent from public AND admin API output");
const dd2 = await kv.get("data");
ok(dd2.includes("anna@example.com"), "email held privately on the unpaid claim (normalised)");

await payFor(r, 50, "Anna GW");
ok(emails().length === 1, "exactly one confirmation email after payment", emails().length);
let em = emails()[0];
ok(em && em.body.to[0] === "anna@example.com", "sent to the donor");
ok(em && em.body.from === "Run TeaTrade <run@teatrade.co.uk>", "sent from Run TeaTrade <run@teatrade.co.uk>", em && em.body.from);
ok(em && /Mile 41/.test(em.body.subject), "subject names the mile", em && em.body.subject);
ok(em && /^confirm-\d+$/.test(em.headers["idempotency-key"]), "idempotency key tied to the donation id", em && em.headers["idempotency-key"]);
ok(em && !em.body.html.includes("<b>Anna") && em.body.html.includes("&lt;b&gt;Anna&lt;/b&gt;") && !em.body.html.includes("<i>fast"), "user text is HTML-escaped in the email");
ok(em && em.body.html.includes("https://run.teatrade.co.uk/#map-section") && em.body.text.includes("Mile 41"), "has map link and plain-text part");
const sub = subs();
ok(sub.length === 1 && sub[0].path === "/contacts" && sub[0].body.topics[0].id === "topic_run" && sub[0].body.topics[0].subscription === "opt_in", "opted-in donor subscribed to the run-updates topic only", sub);
ok(sub.length === 1 && !("unsubscribed" in sub[0].body) && !("segments" in sub[0].body), "new contact is created with the topic only: no global flags, no segments", sub[0] && Object.keys(sub[0].body));
ok(!(await kv.get("data")).includes("anna@example.com"), "email no longer stored once confirmation is sent");
pub = await doPoll(true);
ok(!JSON.stringify(pub).includes("example.com"), "email still absent from API output after confirmation");
await doPoll(); await doPoll(); await flush();
ok(emails().length === 1, "re-polling never re-sends");

reset();
r = await doClaim({ pixel: 42, amount: 50, sponsor_name: "Ben", contact_email: "ben@example.com" }, "10.0.0.3");
await payFor(r, 50, "Ben");
ok(emails().length === 1 && subs().length === 0, "no opt-in tick => confirmation only, NOT added to any list", { e: emails().length, s: subs().length });

reset();
r = await doClaim({ pixel: 43, amount: 50, sponsor_name: "Cara" }, "10.0.0.4");
await payFor(r, 50, "Cara");
ok(emails().length === 0 && subs().length === 0, "no email given => nothing sent");
ok(!!(await doPoll()).sponsorships.find(x => x.pixel === 43), "…and the mile still confirms");

reset(); resendMode = "down";
r = await doClaim({ pixel: 44, amount: 50, sponsor_name: "Dan", contact_email: "dan@example.com", updates_opt_in: true }, "10.0.0.5");
await payFor(r, 50, "Dan");
ok(!!(await doPoll()).sponsorships.find(x => x.pixel === 44), "Resend outage does not block the mile confirming");
resendMode = "ok";

reset(); existingContacts.add("eve@example.com");
r = await doClaim({ pixel: 45, amount: 50, sponsor_name: "Eve", contact_email: "eve@example.com", updates_opt_in: true }, "10.0.0.6");
await payFor(r, 50, "Eve");
ok(subs().some(c => /\/contacts\/eve%40example\.com\/topics$/.test(c.path) && c.method === "PATCH"), "existing contact (e.g. on main list) gets topic opt-in via PATCH, not a new global subscription", subs().map(c => c.method + " " + c.path));
ok(!resendCalls.some(c => c.path === "/contacts" && c.method === "POST"), "existing contact is never re-created or overwritten");

reset(); const savedKey = env.RESEND_API_KEY; delete env.RESEND_API_KEY;
r = await doClaim({ pixel: 46, amount: 50, sponsor_name: "Finn", contact_email: "finn@example.com", updates_opt_in: true }, "10.0.0.7");
await payFor(r, 50, "Finn");
ok(resendCalls.length === 0 && !!(await doPoll()).sponsorships.find(x => x.pixel === 46), "no RESEND_API_KEY => feature off, flow unaffected");
env.RESEND_API_KEY = savedKey;

reset();
dr = await donate(makeCtx(post("/api/donate", { amount: 15, donor_type: "individual", sponsor_name: "Gina", message: "hi", contact_email: "gina@example.com" })));
const gj = await dr.json();
gwPay({ amount: 15, code: new URL(gj.GiveWheel_url).searchParams.get("d_question_1"), name: "Gina" });
await doPoll(); await flush();
ok(emails().length === 1 && /Thank you/.test(emails()[0].body.subject) && !/Mile/.test(emails()[0].body.subject), "general donation gets a thank-you (no mile wording)", emails().map(e => e.body.subject));

reset();
r = await doClaim({ pixel: 47, amount: 50, sponsor_name: "Hal", contact_email: "hal@example.com" }, "10.0.0.8");
const hid = gwPay({ amount: 50, code: r.body.code, name: "Hal" });
const whB = JSON.stringify({ donation: { id: hid, amount: 50, name: "Hal", supporter_questions: [{ response: r.body.code }] } });
const key2 = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig2 = Buffer.from(await crypto.subtle.sign("HMAC", key2, new TextEncoder().encode(whB))).toString("hex");
wr = await webhook(makeCtx(new Request("https://x/w", { method: "POST", body: whB, headers: { "x-givewheel-signature": sig2 } })));
await flush();
const whj = await wr.json();
ok(wr.status === 200 && whj.kind === "pending_match" && !JSON.stringify(whj).includes("example.com"), "webhook path confirms and its response carries no email", whj);
ok(emails().length === 1, "webhook path sends the confirmation too");

console.log("\n16. House rules: sign-off, replies, encoding, neighbourliness");
ok(allEmails.length >= 5, "collected a spread of real emails to check", allEmails.length);
ok(allEmails.every(e => !/\bRob\b/i.test(e.text) && !/\bRob\b/i.test(e.html)), "no email ever names a person");
ok(allEmails.every(e => /Thank you for backing the run\.\nRun TeaTrade/.test(e.text) && /Thank you for backing the run\.<br>Run TeaTrade/.test(e.html)), "every email is signed exactly \"Run TeaTrade\" (text + HTML)");
ok(allEmails.every(e => e.from === "Run TeaTrade <run@teatrade.co.uk>"), "every email is sent from Run TeaTrade <run@teatrade.co.uk>");
ok(allEmails.every(e => e.reply_to === "contact@teatrade.co.uk"), "every email's Reply-To is contact@teatrade.co.uk");
ok(allEmails.every(e => /^[\x00-\x7F]*$/.test(e.html) && /^[\x00-\x7F]*$/.test(e.subject)), "HTML and subject are pure ASCII (no mojibake possible)");
ok(allEmails.some(e => e.html.includes("&#163;50")) && allEmails.some(e => e.text.includes("\u00a350")), "pound sign is correct in HTML (entity) and plain text");
ok(allEmails.every(e => !/<img|<script|onerror/i.test(e.html)), "no injected markup in any email");

reset(); resendMode = "ratelimit_once"; rateLimited = false;
r = await doClaim({ pixel: 48, amount: 50, sponsor_name: "Iris", contact_email: "iris@example.com" }, "10.0.1.1");
await payFor(r, 50, "Iris");
resendMode = "ok";
ok(emails().length === 2 && sentKeys.has(`confirm-${gwId}`), "a 429 from the shared rate limit is retried once, then succeeds", emails().length);

reset();
const ra = await doClaim({ pixel: 49, amount: 50, sponsor_name: "Ann", contact_email: "a1@example.com", updates_opt_in: true }, "10.0.1.2");
const rb = await doClaim({ pixel: 51, amount: 50, sponsor_name: "Bea", contact_email: "b2@example.com", updates_opt_in: true }, "10.0.1.3");
gwPay({ amount: 50, code: ra.body.code, name: "Ann" }); gwPay({ amount: 50, code: rb.body.code, name: "Bea" });
await doPoll(); await flush();
const who = resendCalls.map(c => c.body?.to?.[0] || c.body?.email || decodeURIComponent((c.path.match(/contacts\/([^/]+)/) || [])[1] || ""));
ok(who.includes("a1@example.com") && who.includes("b2@example.com") && who.lastIndexOf("a1@example.com") < who.indexOf("b2@example.com"), "burst of donations is handled one donor at a time (never a flood of parallel API calls)", who);

console.log("\n17. Gear auction: sealed, in-house, with a controllable clock");
const realNow = Date.now;
const setNow = (ms) => { Date.now = () => ms; };
const DAY = 86400000;
setNow(Date.parse("2027-02-10T12:00:00Z"));
const auctionStart = allEmails.length;

const doBid = async (body, ip = "9.9.9.9") => {
  setNow(Date.now() + 1500);
  const r = await auctionBid({ env, request: new Request("https://run.teatrade.co.uk/api/auction/bid", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
const tokenFrom = (e) => /confirm\?t=([A-Z0-9]{24})/.exec(e.body.text)[1];
const getConfirm = (t) => confirmGet({ env, request: new Request(`https://run.teatrade.co.uk/api/auction/confirm?t=${t}`) });
const postConfirm = (t) => { setNow(Date.now() + 1500); const fd = new FormData(); fd.set("t", t); return confirmPost(makeCtx(new Request("https://run.teatrade.co.uk/api/auction/confirm", { method: "POST", body: fd }))); };
const subCount = () => [...kv.m.keys()].filter(k => k.startsWith("sub:")).length;
let ipN = 0; const ip = () => `9.8.${Math.floor(ipN / 250)}.${ipN++ % 250}`;
const placeAndConfirm = async (item, amount, company, email) => {
  reset();
  const r = await doBid({ item, bid_amount: amount, company_name: company, contact_email: email }, ip());
  const t = tokenFrom(emails()[0]);
  await postConfirm(t); await flush();
  return { r, t };
};

let bb = await doBid({ item: "nope", bid_amount: 500, company_name: "X", contact_email: "x@x.com" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_item", "unknown item refused", bb);
bb = await doBid({ item: "front-chest", bid_amount: 499, company_name: "X", contact_email: "x@x.com" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_amount" && bb.body.min === 500, "bid below the item's minimum refused (minimum returned)", bb);
bb = await doBid({ item: "front-chest", bid_amount: 500.5, company_name: "X", contact_email: "x@x.com" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_amount", "fractional pounds refused");
bb = await doBid({ item: "front-chest", bid_amount: 60000, company_name: "X", contact_email: "x@x.com" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_amount", "absurd amount refused");
bb = await doBid({ item: "front-chest", bid_amount: 600, company_name: "X", contact_email: "nope" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_email", "bad email refused");
bb = await doBid({ item: "front-chest", bid_amount: 600, company_name: "   ", contact_email: "x@x.com" }, ip());
ok(bb.status === 400 && bb.body.error === "bad_company", "blank company refused");
let n0 = subCount(); reset();
bb = await doBid({ item: "front-chest", bid_amount: 600, company_name: "Bot", contact_email: "bot@x.com", website: "http://spam" }, ip());
ok(bb.status === 200 && subCount() === n0 && emails().length === 0, "honeypot: bots get a fake success but nothing is stored or emailed");
const savedKey2 = env.RESEND_API_KEY; delete env.RESEND_API_KEY;
bb = await doBid({ item: "front-chest", bid_amount: 600, company_name: "X", contact_email: "x@x.com" }, ip());
ok(bb.status === 503 && bb.body.error === "email_unavailable", "can't take bids if verification emails can't be sent");
env.RESEND_API_KEY = savedKey2;

reset();
bb = await doBid({ item: "front-chest", bid_amount: 600, company_name: "Acme Tea Ltd", contact_email: "A@Acme.com" }, ip());
ok(bb.status === 200 && bb.body.ok, "valid bid accepted", bb);
let ve = emails()[0];
ok(ve && ve.body.to[0] === "a@acme.com" && /Confirm your bid on Front Chest/.test(ve.body.subject), "verification email goes to the bidder", ve && ve.body.subject);
ok(ve.body.text.includes("Front Chest (T-Shirt)") && ve.body.text.includes("\u00a3600") && ve.body.text.includes("Acme Tea Ltd") && ve.body.text.includes("28 February 2027 at 23:59 GMT"), "it states item, amount, company and the closing time");
const tok1 = tokenFrom(ve);
ok((await listBids(env, "front-chest")).length === 0, "an unconfirmed bid does not count");
const g1 = await getConfirm(tok1); const g1t = await g1.text();
ok(g1.status === 200 && g1t.includes("Confirm my bid") && g1t.includes("Front Chest") && g1t.includes("&#163;600") && /^[\x00-\x7F]*$/.test(g1t), "confirm page shows the bid and a button (ASCII-safe)");
ok((await listBids(env, "front-chest")).length === 0, "merely opening the link (as a mail scanner would) does NOT confirm the bid");
const p1 = await postConfirm(tok1); await flush();
ok(p1.status === 200 && (await p1.text()).includes("Your bid is confirmed"), "pressing the button confirms it");
const rc = emails().find(e => /Your bid is confirmed: Front Chest/.test(e.body.subject));
ok(rc && rc.body.to[0] === "a@acme.com" && rc.body.text.includes("\u00a3600") && rc.body.text.includes("Front Chest (T-Shirt)") && rc.body.text.includes("7 March 2027"), "receipt email gives item, amount and what happens next");
let fc = await listBids(env, "front-chest");
ok(fc.length === 1 && fc[0].amount === 600, "bid is stored", fc);
reset(); const p1b = await postConfirm(tok1); await flush();
ok((await p1b.text()).includes("Already confirmed") && emails().length === 0, "confirming twice is harmless and sends no second receipt");

reset(); resendMode = "down"; const subsN = subCount();
bb = await doBid({ item: "front-chest", bid_amount: 700, company_name: "Down Co", contact_email: "d@down.com" }, ip());
resendMode = "ok";
ok(bb.status === 502 && bb.body.error === "email_failed" && subCount() === subsN, "if the email can't be sent the bidder is told and nothing is left behind", bb);

reset();
bb = await doBid({ item: "front-chest", bid_amount: 650, company_name: "Acme Tea Ltd", contact_email: "a@acme.com" }, ip());
const tok2 = tokenFrom(emails()[0]);
ok((await listBids(env, "front-chest"))[0].amount === 600, "a revision doesn't replace the confirmed bid until it is confirmed too");
await postConfirm(tok2); await flush();
fc = await listBids(env, "front-chest");
ok(fc.length === 1 && fc[0].amount === 650, "confirming the revision updates the same bid (one bid per bidder per item)", fc);
const oldLink = await postConfirm(tok1); const oldTxt = await oldLink.text();
ok(oldTxt.includes("newer bid") && (await listBids(env, "front-chest"))[0].amount === 650, "an older link can't overwrite a newer bid");

await placeAndConfirm("front-chest", 620, "Brew Co", "b@brew.com");
await placeAndConfirm("front-chest", 650, "C Tea", "c@c.com");
fc = await listBids(env, "front-chest");
ok(fc.map(b => b.company).join("|") === "Acme Tea Ltd|C Tea|Brew Co", "ranking: highest first, equal bids go to the earliest confirmation", fc.map(b => b.company + b.amount));
await placeAndConfirm("upper-back", 400, "Acme Tea Ltd", "a@acme.com");
await placeAndConfirm("upper-back", 450, "Brew Co", "b@brew.com");
await placeAndConfirm("right-sleeve", 300, "E Co", "e@e.com");
await placeAndConfirm("right-sleeve", 250, "F Co", "f@f.com");
reset();
const dBid = await doBid({ item: "cap", bid_amount: 200, company_name: "D Ltd", contact_email: "d@d.com" }, ip());
const tokD = tokenFrom(emails()[0]);
const pubOpen = await (await auctionStatus(makeCtx(new Request("https://run.teatrade.co.uk/api/auction")))).json();
ok(pubOpen.open === true && pubOpen.items.length === 9 && pubOpen.items.every(i => i.status === "open") && !/@|acme|brew/i.test(JSON.stringify(pubOpen)), "public status: nine open items, no bids or bidders exposed");

setNow(AUCTION_CLOSES_MS - 12 * 3600e3);
reset(); await auctionTick(env, Date.now()); await flush();
ok(emails().length === 1 && emails()[0].body.to[0] === "d@d.com" && /Last chance to confirm your bid on Running Cap/.test(emails()[0].body.subject), "in the last 24h only the unconfirmed bidder gets a reminder (once)", emails().map(e => e.body.to[0] + " " + e.body.subject));
reset(); await auctionTick(env, Date.now());
ok(emails().length === 0, "the reminder is not repeated");

const emailRun = []; for (let i = 0; i < 6; i++) emailRun.push(await doBid({ item: "cap", bid_amount: 200, company_name: "Spam", contact_email: "spam@x.com" }, ip()));
ok(emailRun.slice(0, 5).every(r => r.status === 200) && emailRun[5].status === 429 && emailRun[5].body.error === "too_many", "one email address can't be used to flood verification emails");
const ipRun = []; for (let i = 0; i < 9; i++) ipRun.push(await doBid({ item: "cap", bid_amount: 200, company_name: "Spam", contact_email: `ip${i}@x.com` }, "9.7.7.7"));
ok(ipRun.slice(0, 8).every(r => r.status === 200) && ipRun[8].status === 429, "one network address is rate-limited");
await kv.put("rl:all:2027-02-28", "60");
bb = await doBid({ item: "cap", bid_amount: 200, company_name: "Late", contact_email: "late@x.com" }, ip());
ok(bb.status === 429 && bb.body.error === "busy", "a daily cap protects the shared Resend quota");
await kv.put("rl:all:2027-02-28", "0");

setNow(AUCTION_CLOSES_MS + 1000);
bb = await doBid({ item: "cap", bid_amount: 200, company_name: "Late", contact_email: "late@x.com" }, ip());
ok(bb.status === 403 && bb.body.error === "closed", "no bids after the close", bb);
const lateTxt = await (await postConfirm(tokD)).text();
ok(lateTxt.includes("Bidding has closed") && (await listBids(env, "cap")).length === 0, "an unconfirmed bid can't be confirmed after close");

reset(); await auctionTick(env, AUCTION_CLOSES_MS + 60e3);
ok(emails().length === 0 && !(JSON.parse(await kv.get("auction:state")).closedAt), "nothing is decided during the short grace period");

setNow(AUCTION_CLOSES_MS + 3 * 60e3); reset();
await auctionTick(env, Date.now()); await flush();
const st = JSON.parse(await kv.get("auction:state"));
ok(st.closedAt && st.items["front-chest"].company === "Acme Tea Ltd" && st.items["front-chest"].amount === 650, "winner = highest bid; a tie goes to the earliest confirmed", st.items["front-chest"]);
ok(st.items["upper-back"].company === "Brew Co" && st.items["upper-back"].amount === 450, "second item awarded");
ok(st.items["right-sleeve"].company === "E Co" && st.items["right-sleeve"].amount === 300, "third item awarded");
ok(st.items["cap"].status === "nobids" && st.items["left-sleeve"].status === "nobids", "unconfirmed or missing bids mean no winner");
const wonEs = emails().filter(e => /^You won /.test(e.body.subject));
const lostEs = emails().filter(e => /^Result of your bid/.test(e.body.subject));
ok(wonEs.length === 3 && lostEs.length === 4, "3 winner and 4 not-successful emails", { won: wonEs.length, lost: lostEs.length });
const wAcme = wonEs.find(e => e.body.to[0] === "a@acme.com");
const payLink = new URL(/donation: (https:\/\/\S+)/.exec(wAcme.body.text)[1]);
ok(payLink.searchParams.get("donation") === "650" && payLink.searchParams.get("lock_amount") === "true" && /^G1-[A-Z0-9]{4}$/.test(payLink.searchParams.get("d_question_1")), "winner gets a personal GiveWheel link: amount locked, gear lock code", payLink.search);
ok(wAcme.body.text.includes("7 March 2027 at 23:59 GMT") && /vector/.test(wAcme.body.text) && wAcme.body.text.includes("2 April 2027"), "winner email states the 7 March deadline and logo requirements for the 2 April run");
const lostBrew = lostEs.find(e => e.body.to[0] === "b@brew.com");
ok(lostBrew.body.text.includes("\u00a3620") && !lostBrew.body.text.includes("\u00a3650"), "not-successful email shows only the bidder's own bid, never another's");
ok(emails().some(e => e.body.to[0] === "contact@teatrade.co.uk" && /Gear auction closed/.test(e.body.subject)), "organiser gets a results summary");
reset(); await auctionTick(env, Date.now());
ok(emails().length === 0, "closing is idempotent: nothing is re-sent");
const pubClosed = await (await auctionStatus(makeCtx(new Request("https://run.teatrade.co.uk/api/auction")))).json();
ok(pubClosed.open === false && pubClosed.items.every(i => i.status === "closed") && !/@|acme|brew|650|450/i.test(JSON.stringify(pubClosed)), "after close every card reads closed; still no bids exposed");

const codeAcme = payLink.searchParams.get("d_question_1");
reset(); gwPay({ amount: 650, code: codeAcme, name: "Acme" });
pub = await doPoll(true); await flush();
ok(emails().some(e => e.body.to[0] === "a@acme.com" && /^Payment received: Front Chest/.test(e.body.subject)), "winner is thanked when payment lands");
ok(emails().some(e => e.body.to[0] === "contact@teatrade.co.uk" && /^Gear paid: Front Chest/.test(e.body.subject)), "organiser is told too");
ok(!pub.orphan_donations.some(o => o.code === codeAcme), "gear payment is recognised, not orphaned");
let ps = await (await auctionStatus(makeCtx(new Request("https://run.teatrade.co.uk/api/auction?x=1")))).json();
ok(ps.items.find(i => i.id === "front-chest").status === "paid" && ps.items.find(i => i.id === "front-chest").sponsor === "Acme Tea Ltd", "the card now shows the sponsor");
const codeBrew = st.items["upper-back"].code;
reset(); gwPay({ amount: 100, code: codeBrew, name: "Brew" }); gwPay({ amount: 150, code: "G9-ZZZZ", name: "Nobody" });
pub = await doPoll(true); await flush();
ok(pub.orphan_donations.some(o => o.code === codeBrew && o.reason === "gear_underpaid") && pub.orphan_donations.some(o => o.code === "G9-ZZZZ" && o.reason === "gear_no_offer"), "underpayments and unknown gear codes are flagged for the admin, money still counted");
ok(JSON.parse(await kv.get("auction:state")).items["upper-back"].status === "offered", "an underpayment does not mark the item paid");
reset(); gwPay({ amount: 450, code: codeBrew, name: "Brew" });
await doPoll(true); await flush();
ok(JSON.parse(await kv.get("auction:state")).items["upper-back"].status === "paid", "full payment marks it paid");

setNow(PAY_BY_MS - 2.5 * DAY); reset(); await auctionTick(env, Date.now());
ok(emails().length === 1 && emails()[0].body.to[0] === "e@e.com" && /^Reminder/.test(emails()[0].body.subject), "3-day reminder goes only to the unpaid winner", emails().map(e => e.body.to[0] + " " + e.body.subject));
reset(); await auctionTick(env, Date.now());
ok(emails().length === 0, "not repeated");
setNow(PAY_BY_MS - 20 * 3600e3); reset(); await auctionTick(env, Date.now());
ok(emails().length === 1 && /Final reminder/.test(emails()[0].body.text), "final reminder the day before");
setNow(PAY_BY_MS + 60e3); reset(); await auctionTick(env, Date.now());
ok(emails().some(e => e.body.to[0] === "contact@teatrade.co.uk" && /offer lapsed/.test(e.body.subject)) && JSON.parse(await kv.get("auction:state")).items["right-sleeve"].status === "lapsed", "unpaid offer lapses after 7 March and the organiser is told");

const noAuth = await adminAuctionGet({ env, request: new Request("https://run.teatrade.co.uk/api/admin/auction") });
ok(noAuth.status === 403, "admin auction view needs the secret");
const adminHdr = { "x-admin-secret": "adm", "content-type": "application/json" };
const ov = await (await adminAuctionGet({ env, request: new Request("https://run.teatrade.co.uk/api/admin/auction", { headers: adminHdr }) })).json();
const rsItem = ov.items.find(i => i.id === "right-sleeve");
ok(ov.closed && rsItem.bids.length === 2 && rsItem.state.status === "lapsed", "admin sees every confirmed bid and the lapsed offer", rsItem.bids);
const fBid = rsItem.bids.find(b => b.company === "F Co");
reset();
let off = await adminAuctionPost({ env, request: new Request("https://run.teatrade.co.uk/api/admin/auction", { method: "POST", headers: adminHdr, body: JSON.stringify({ action: "offer", item: "right-sleeve", bid_key: fBid.key, days: 3 }) }) });
const offJ = await off.json();
ok(off.status === 200 && offJ.ok && offJ.offer.amount === 250 && offJ.offer.company === "F Co", "admin can offer the item to the next bidder", offJ);
const offerEmail = emails().find(e => e.body.to[0] === "f@f.com" && /^You won Right Sleeve/.test(e.body.subject));
ok(offerEmail && offerEmail.body.text.includes("March 2027"), "the new offer email carries its own deadline");
reset(); gwPay({ amount: 250, code: offJ.offer.code, name: "F" });
await doPoll(true); await flush();
ps = await (await auctionStatus(makeCtx(new Request("https://run.teatrade.co.uk/api/auction?x=2")))).json();
ok(ps.items.find(i => i.id === "right-sleeve").sponsor === "F Co", "payment on the new offer sponsors the item");
off = await adminAuctionPost({ env, request: new Request("https://run.teatrade.co.uk/api/admin/auction", { method: "POST", headers: adminHdr, body: JSON.stringify({ action: "offer", item: "front-chest", bid_key: (ov.items.find(i => i.id === "front-chest").bids[0]).key }) }) });
ok(off.status === 400 && (await off.json()).error === "already_paid", "a paid item can't be re-offered");

const AE = allEmails.slice(auctionStart);
ok(AE.length >= 25, "collected the auction emails to check", AE.length);
ok(AE.every(e => e.from === "Run TeaTrade <run@teatrade.co.uk>" && e.reply_to === "contact@teatrade.co.uk"), "auction emails: from run@, replies to contact@");
ok(AE.every(e => /\nRun TeaTrade\n/.test(e.text) && e.html.includes("<br>Run TeaTrade</p>")), "auction emails: signed exactly 'Run TeaTrade'");
ok(AE.every(e => !/\bRob\b/i.test(e.text + e.html)), "auction emails: never a personal name");
ok(AE.every(e => /^[\x00-\x7F]*$/.test(e.html) && /^[\x00-\x7F]*$/.test(e.subject)), "auction emails: ASCII-safe HTML and subjects");
ok(AE.every(e => !/outbid|leading|\brank|top spot|in the lead/i.test(e.subject + " " + e.text)), "SEALED: no email ever mentions rank, leading or being outbid");
ok(![...kv.m.keys()].some(k => k.includes("@")), "no raw email addresses in any storage key");
Date.now = realNow;

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
