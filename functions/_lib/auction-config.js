/**
 * Gear auction configuration: the single place for dates and items.
 * Item names must match the cards in index.html (data-id / data-item).
 *
 * The auction is SEALED: nobody is ever told whether they lead or have been
 * outbid. Bidders get their own bid receipt; only the final result is sent
 * after close.
 */
export const AUCTION_CLOSES_MS = Date.parse("2027-02-28T23:59:59Z");  // last day of February (GMT)
export const PAY_BY_MS         = Date.parse("2027-03-07T23:59:59Z");  // winners' payment deadline (GMT)
export const RUN_DAY_TEXT      = "2 April 2027";

export const CLOSE_GRACE_MS = 2 * 60 * 1000;   // tally waits for KV listings to settle
export const DAY_MS         = 24 * 60 * 60 * 1000;
export const MAX_BID        = 50000;

export const ITEMS = [
  { n: 1, id: "front-chest",        name: "Front Chest (T-Shirt)",     min: 500 },
  { n: 2, id: "upper-back",         name: "Upper Back (T-Shirt)",      min: 400 },
  { n: 3, id: "right-sleeve",       name: "Right Sleeve (T-Shirt)",    min: 250 },
  { n: 4, id: "left-sleeve",        name: "Left Sleeve (T-Shirt)",     min: 250 },
  { n: 5, id: "cap",                name: "Running Cap (Front Panel)", min: 150 },
  { n: 6, id: "right-leg-trousers", name: "Right Leg (Trousers)",      min: 200 },
  { n: 7, id: "left-leg-trousers",  name: "Left Leg (Trousers)",       min: 200 },
  { n: 8, id: "right-leg-shorts",   name: "Right Leg (Shorts)",        min: 150 },
  { n: 9, id: "left-leg-shorts",    name: "Left Leg (Shorts)",         min: 150 },
];

export const itemById = (id) => ITEMS.find(i => i.id === id) || null;
export const itemByCodeNumber = (n) => ITEMS.find(i => i.n === n) || null;

const londonParts = (ms) => {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  });
  return Object.fromEntries(f.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
};

// "7 March 2027"
export function fmtDate(ms) {
  const p = londonParts(ms);
  return `${p.day} ${p.month} ${p.year}`;
}

// "28 February 2027 at 23:59 GMT"
export function fmtDateTime(ms) {
  const p = londonParts(ms);
  return `${p.day} ${p.month} ${p.year} at ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

export const gbp = (n) => `\u00a3${Number(n || 0).toLocaleString("en-GB")}`;
