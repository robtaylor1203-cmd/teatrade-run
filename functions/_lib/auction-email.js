/**
 * Gear auction emails. House rules: signed "Run TeaTrade" (never a person),
 * from run@teatrade.co.uk with replies to contact@, and NEVER any rank or
 * "you're leading / you've been outbid" messaging: the auction is sealed.
 */
import { sendEmail, renderEmail } from "./email.js";
import { checkoutUrl } from "./sponsor.js";
import {
  AUCTION_CLOSES_MS, PAY_BY_MS, RUN_DAY_TEXT, itemById, fmtDate, fmtDateTime, gbp,
} from "./auction-config.js";

const SITE = "https://run.teatrade.co.uk";
const OWNER_DEFAULT = "contact@teatrade.co.uk";

const itemName = (id) => itemById(id)?.name || id;

export const payUrl = (st) => checkoutUrl({
  amount: st.amount, lock: true, code: st.code, name: st.company,
  message: `${itemName(st.item)} sponsorship`,
});

const bidFacts = (b) => [
  ["Item", itemName(b.item)],
  ["Your bid", gbp(b.amount)],
  ["Company", b.company],
  ["Bidding closes", fmtDateTime(AUCTION_CLOSES_MS)],
];

// 1. Sent when a bid is submitted: the bid only counts once confirmed.
export function verifyEmail(sub, confirmUrl) {
  const { html, text } = renderEmail({
    headline: "Please confirm your bid.",
    paragraphs: [
      `Thank you for bidding on ${itemName(sub.item)}. Your bid only counts once you confirm it with the button below. If you didn't place this bid, just ignore this email and nothing will happen.`,
    ],
    facts: bidFacts(sub),
    button: { label: "Confirm my bid", url: confirmUrl },
    closing: "Thank you for backing the run.",
  });
  return { subject: `Confirm your bid on ${itemName(sub.item)} | Run TeaTrade`, html, text };
}

// 2. Receipt once confirmed. Item + amount; nothing about anyone else's bids.
export function receiptEmail(bid) {
  const { html, text } = renderEmail({
    headline: "Your bid is confirmed.",
    paragraphs: [
      `Thank you, ${bid.company}. We have recorded your bid for ${itemName(bid.item)}.`,
      `This is a sealed auction: bids are private and are never published. When bidding closes on ${fmtDate(AUCTION_CLOSES_MS)} the highest confirmed bid wins and the winner is told by email. Winners complete their GiveWheel donation and supply logo files by ${fmtDate(PAY_BY_MS)} so the kit can be printed in time for the run on ${RUN_DAY_TEXT}.`,
      "To change your bid, simply submit a new bid for the same item using this email address and confirm it. Your most recently confirmed bid is the one that counts.",
    ],
    facts: bidFacts(bid),
    closing: "Thank you for backing the run.",
  });
  return { subject: `Your bid is confirmed: ${itemName(bid.item)} | Run TeaTrade`, html, text };
}

// 3. One reminder in the last 24 hours to people who haven't confirmed.
export function nudgeEmail(sub, confirmUrl) {
  const { html, text } = renderEmail({
    headline: "Your bid is not confirmed yet.",
    paragraphs: [
      `You started a bid on ${itemName(sub.item)} but haven't confirmed it, so it won't count. Bidding closes on ${fmtDate(AUCTION_CLOSES_MS)}. Confirm with the button below to enter.`,
    ],
    facts: bidFacts(sub),
    button: { label: "Confirm my bid", url: confirmUrl },
  });
  return { subject: `Last chance to confirm your bid on ${itemName(sub.item)} | Run TeaTrade`, html, text };
}

// 4. Winner: personal GiveWheel link with the amount locked.
export function wonEmail(st) {
  const { html, text } = renderEmail({
    headline: "Your bid won.",
    paragraphs: [
      `Congratulations ${st.company}. Your bid of ${gbp(st.amount)} was the winning bid for ${itemName(st.item)}.`,
      `To secure it, please complete your ${gbp(st.amount)} donation through GiveWheel by ${fmtDateTime(st.deadline)}. The button below opens GiveWheel with the amount ready. 100% goes to Alzheimer's Research UK and the UK Tea Trade Benevolent Society.`,
      `Please also reply to this email with your logo as a vector file (PDF, SVG or AI) or a high-resolution PNG by the same date, so your gear can be printed in time for the run on ${RUN_DAY_TEXT}.`,
      "If payment hasn't been received by the deadline we may need to offer the item to another bidder.",
    ],
    facts: [
      ["Item", itemName(st.item)],
      ["Winning bid", gbp(st.amount)],
      ["Pay and send logo by", fmtDateTime(st.deadline)],
    ],
    button: { label: `Complete my ${gbp(st.amount)} donation`, url: payUrl(st) },
  });
  return { subject: `You won ${itemName(st.item)} | Run TeaTrade`, html, text };
}

// 5. Everyone else, after close. Courteous, no amounts, points back to the run.
export function lostEmail(entry) {
  const { html, text } = renderEmail({
    headline: "Thank you for bidding.",
    paragraphs: [
      `Bidding on ${itemName(entry.item)} has now closed. On this occasion your bid of ${gbp(entry.amount)} was not the highest, but your support means a great deal.`,
      "If you'd still like to be part of the run, you can sponsor a mile or make a donation of any amount on the site.",
    ],
    button: { label: "See the route and sponsor a mile", url: `${SITE}/#map-section` },
  });
  return { subject: `Result of your bid on ${itemName(entry.item)} | Run TeaTrade`, html, text };
}

// 6. Reminder to a winner who hasn't paid yet.
export function reminderEmail(st, label) {
  const { html, text } = renderEmail({
    headline: label === "1d" ? "Final reminder: please complete your donation." : "A reminder to complete your donation.",
    paragraphs: [
      `Your winning bid of ${gbp(st.amount)} for ${itemName(st.item)} is waiting for payment. Please complete it through GiveWheel by ${fmtDateTime(st.deadline)} so your gear can be printed in time for the run on ${RUN_DAY_TEXT}.`,
      "If you've already paid, thank you, and you can ignore this message.",
    ],
    button: { label: `Complete my ${gbp(st.amount)} donation`, url: payUrl(st) },
  });
  return { subject: `Reminder: complete your donation for ${itemName(st.item)} | Run TeaTrade`, html, text };
}

// 7. Payment received.
export function paidEmail(st) {
  const { html, text } = renderEmail({
    headline: "Payment received. Thank you.",
    paragraphs: [
      `Your ${gbp(st.amount)} donation for ${itemName(st.item)} has been received, and ${st.company} is now the sponsor of that spot on the run kit.`,
      `If you haven't already, please reply to this email with your logo as a vector file (PDF, SVG or AI) or a high-resolution PNG by ${fmtDate(PAY_BY_MS)} so it can be printed in time for ${RUN_DAY_TEXT}.`,
    ],
    facts: [["Item", itemName(st.item)], ["Donation", gbp(st.amount)]],
  });
  return { subject: `Payment received: ${itemName(st.item)} | Run TeaTrade`, html, text };
}

// ---- notes to the organiser (never to bidders) ----------------------------

export function ownerClosedEmail(state) {
  const lines = Object.entries(state.items).map(([id, st]) =>
    st.status === "nobids" ? `${itemName(id)}: no confirmed bids`
      : `${itemName(id)}: ${st.company} (${st.email}) won at ${gbp(st.amount)} from ${st.bidders} bid${st.bidders === 1 ? "" : "s"}`);
  const { html, text } = renderEmail({
    eyebrow: "Run TeaTrade admin",
    headline: "The gear auction has closed.",
    paragraphs: [
      "Winners have been emailed a personal GiveWheel link and told to pay and send logos by " + fmtDateTime(PAY_BY_MS) + ".",
      ...lines,
    ],
    closing: "Review everything on the admin page.",
    footer: "Internal notification from the run site.",
  });
  return { subject: "Gear auction closed: results | Run TeaTrade", html, text };
}

export function ownerPaidEmail(st) {
  const { html, text } = renderEmail({
    eyebrow: "Run TeaTrade admin",
    headline: `Gear paid: ${itemName(st.item)}`,
    paragraphs: [`${st.company} (${st.email}) paid ${gbp(st.amount)}. Their logo files are due by ${fmtDate(PAY_BY_MS)}.`],
    closing: "Nothing else to do here.",
    footer: "Internal notification from the run site.",
  });
  return { subject: `Gear paid: ${itemName(st.item)} | Run TeaTrade`, html, text };
}

export function ownerLapsedEmail(st) {
  const { html, text } = renderEmail({
    eyebrow: "Run TeaTrade admin",
    headline: `Offer lapsed: ${itemName(st.item)}`,
    paragraphs: [
      `${st.company} (${st.email}) did not pay ${gbp(st.amount)} by ${fmtDateTime(st.deadline)}.`,
      "Open the admin page to see the other bids and offer the item to the next bidder.",
    ],
    closing: "Thank you.",
    footer: "Internal notification from the run site.",
  });
  return { subject: `Gear offer lapsed: ${itemName(st.item)} | Run TeaTrade`, html, text };
}

export const ownerAddress = (env) => env.AUCTION_NOTIFY_TO || OWNER_DEFAULT;

// Small convenience used by the logic layer.
export async function deliver(env, to, built, idempotencyKey) {
  return sendEmail(env, { to, subject: built.subject, html: built.html, text: built.text, idempotencyKey });
}
