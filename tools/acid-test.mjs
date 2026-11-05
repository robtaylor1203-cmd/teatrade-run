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
  async put(k, v, opts) { this.m.set(k, { v: String(v), ttl: opts?.expirationTtl ?? null }); }
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
  gwCalls++;
  const u = String(url);
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

// ---- helpers --------------------------------------------------------
const kv = new KV();
const env = {
  SPONSORSHIPS_KV: kv, GIVEWHEEL_USERNAME: "u@x", GIVEWHEEL_PASSWORD: "pw",
  ADMIN_SECRET: "adm", GIVEWHEEL_WEBHOOK_SECRET: "whsec",
};
const makeCtx = (request) => ({ request, env, waitUntil() {} });
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

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

