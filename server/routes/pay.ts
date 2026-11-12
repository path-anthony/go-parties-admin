import { Router, type Response } from "express";
import { apiBase } from "../contract/links.js";
import { ContractError, prepareContract } from "../contracts.js";
import { prisma } from "../db.js";
import { safeErr } from "../log.js";
import { COMPANY_NAME, prettyPhone } from "../messageContext.js";
import { owedFor, payLinkFor, usd } from "../payLink.js";
import { PaymentError, createPaymentSession, paymentStatus } from "../payments.js";
import { currentPolicy, fillPolicyText } from "../policy.js";
import { customerStage } from "../portal.js";
import { bookingItemLines } from "../bookingItems.js";
import { daysBefore } from "../contract/goMoney.js";
import { POLICY_FACTS_SELECT, acceptPolicy, policyStateOf } from "../policyAccept.js";
import { StripeError } from "../stripe/client.js";

// Block F1. The pay link. One private address per booking,
// <admin>/pay/<token>, that takes the customer to whatever they owe next:
// the contract to sign, then the retainer, then the balance. No account is
// needed; the token is the key, the same pattern as the contract link.
//
// The pages here are plain and small on purpose. A proper storefront screen
// at /pay/:token can replace them later using the JSON routes at the bottom
// (see docs/S9-CONTRACT.md).
//
// Nothing here charges a card. A payment happens on Stripe's own page, by the
// customer, and the app learns of it from Stripe.

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(res: Response, status: number, title: string, lines: string[], link?: { href: string; label: string }) {
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f4;color:#1c1c1c;margin:0;padding:24px}main{max-width:460px;margin:8vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;margin:0 0 12px}a.btn{display:inline-block;margin-top:8px;background:#1c1c1c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px}small{color:#666}</style></head>
<body><main><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${link ? `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>` : ""}<p><small>${esc(COMPANY_NAME)}</small></p></main></body></html>`);
}

const storefront = () => process.env.STOREFRONT_URL?.replace(/\/$/, "") ?? "";
const myParty = () => (storefront() ? { href: `${storefront()}/party`, label: "Go to My party" } : undefined);

async function bookingByToken(token: string) {
  if (!TOKEN.test(token)) return null;
  return prisma.booking.findUnique({ where: { payToken: token }, select: { id: true } });
}

const eventDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

// ---- the link itself: pages and redirects ------------------------------------------

export const payPagesRouter = Router();

payPagesRouter.get("/:token", async (req, res) => {
  const token = String(req.params.token);
  const found = await bookingByToken(token);
  if (!found) return page(res, 404, "This link doesn't work", ["Check that you opened the whole link from our message. If it still doesn't work, reply to that message or call us."]);
  try {
    const owed = await owedFor(found.id);
    const phone = owed.settings.rushContactPhone?.trim() || prettyPhone(process.env.TWILIO_PHONE_NUMBER);
    if (owed.step === "closed") return page(res, 200, "Nothing to pay", ["This booking is cancelled or already finished, so nothing is owed."], myParty());
    if (owed.step === "nothing") return page(res, 200, "You're all paid up", [`Nothing is owed right now on your booking for ${eventDay(owed.booking.eventDate)}. Thank you.`], myParty());
    if (owed.step === "sign") {
      // The contract comes first. The signing page works without an account.
      const prepared = await prepareContract({ bookingId: found.id });
      return res.redirect(303, prepared.link);
    }
    const base = `${apiBase(req)}/pay/${token}`;
    const offer = await createPaymentSession(found.id, owed.step, { successUrl: `${base}/done?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${base}/back` });
    if (!offer) return page(res, 200, "Online payment isn't set up yet", [`To pay the ${owed.step} of ${usd(owed.amountCents ?? 0)}, call or text us${phone ? ` at ${phone}` : ""}.`]);
    return res.redirect(303, offer.url);
  } catch (err) {
    if (err instanceof PaymentError && (err.reason === "nothing-due" || err.reason === "not-payable")) return page(res, 200, "Nothing to pay right now", [err.message], myParty());
    if (!(err instanceof StripeError) && !(err instanceof ContractError) && !(err instanceof PaymentError)) console.error("[pay link] failed:", safeErr(err));
    return page(res, 502, "We couldn't open the payment page", ["Nothing was charged. Try your link again in a minute, or call or text us."]);
  }
});

// Stripe sends the customer back here after paying. The session is checked
// with Stripe now, so a late webhook never leaves a paid customer in doubt.
payPagesRouter.get("/:token/done", async (req, res) => {
  const found = await bookingByToken(String(req.params.token));
  if (!found) return page(res, 404, "This link doesn't work", ["Check that you opened the whole link from our message."]);
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  const view = /^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId) ? await paymentStatus(sessionId).catch(() => null) : null;
  if (view && view.bookingId === found.id && view.paid) {
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: found.id }, select: { eventDate: true, status: true, tier: true, retainerPaid: true, confirmedAt: true } });
    const confirmed = customerStage(b) === "Confirmed";
    return page(res, 200, "Payment received. Thank you.", [confirmed ? `Your booking for ${eventDay(b.eventDate)} is confirmed.` : `We have your payment for ${eventDay(b.eventDate)}.`, "A confirmation is on its way by text and email."], myParty());
  }
  return page(res, 200, "Thanks. We're confirming your payment.", ["This can take a minute. You'll get a text and an email as soon as it's confirmed. You can close this page."], myParty());
});

payPagesRouter.get("/:token/back", async (req, res) => {
  const token = String(req.params.token);
  const found = await bookingByToken(token);
  if (!found) return page(res, 404, "This link doesn't work", ["Check that you opened the whole link from our message."]);
  return page(res, 200, "No payment was made", ["Nothing was charged. Your link still works whenever you're ready."], { href: payLinkFor(token), label: "Go back to pay" });
});

// ---- the same thing as JSON, for a storefront pay screen ---------------------------

export const payApiRouter = Router();

payApiRouter.get("/:token", async (req, res) => {
  const found = await bookingByToken(String(req.params.token));
  if (!found) return res.status(404).json({ error: "That pay link isn't known.", reason: "not-found" });
  const owed = await owedFor(found.id);
  const b = owed.booking;
  let contractLink: string | null = null;
  if (owed.step === "sign") {
    try {
      contractLink = (await prepareContract({ bookingId: b.id })).link;
    } catch (err) {
      if (!(err instanceof ContractError)) throw err;
    }
  }
  // A small rental has no contract: the rental policy is what applies.
  const policy = b.tier !== 2 ? await currentPolicy(b.accountId) : null;
  // Block F3b: what is on the booking, and whether the customer has accepted
  // the policy themselves (here, or at checkout in the store).
  const more = await prisma.booking.findUniqueOrThrow({
    where: { id: b.id },
    select: { ...POLICY_FACTS_SELECT, policyAcceptedText: true, policyAcceptedVersionId: true, guestCount: true, eventTime: true, package: { select: { name: true } }, units: { select: { unit: { select: { item: { select: { name: true } } } } } }, gigs: { select: { itemName: true, skill: true, status: true } } },
  });
  const accepted = policyStateOf(more);
  // Once accepted on the pay link, the text shown is the one they accepted.
  const shownPolicy =
    more.policyAcceptedAt && more.policyAcceptedText && more.policyAcceptedVersionId
      ? { id: more.policyAcceptedVersionId, version: more.policyAcceptedVersion ?? 0, text: more.policyAcceptedText }
      : policy && policy.text.trim() !== ""
        ? { id: policy.id, version: policy.version, text: fillPolicyText(policy.text, owed.settings) }
        : null;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    step: owed.step,
    amount: owed.amountCents === null ? null : owed.amountCents / 100,
    kind: owed.step === "retainer" || owed.step === "sign" ? "retainer" : owed.step === "balance" ? "balance" : null,
    stage: customerStage(b),
    eventDate: b.eventDate.toISOString().slice(0, 10),
    customerFirstName: b.customerName.trim().split(/\s+/)[0] ?? "",
    total: owed.money.totalCents === null ? null : owed.money.totalCents / 100,
    paid: owed.money.paidCents / 100,
    retainerPaid: owed.money.retainerPaid,
    balancePaid: owed.money.balancePaid,
    contractLink,
    // The numbers in the text are already filled in; show it as it is.
    policy: b.tier !== 2 ? shownPolicy : null,
    // Block F3b. policyRequired: this booking has a policy to accept (false on
    // a contract booking). policyAccepted: the customer has accepted it.
    policyRequired: accepted.needed,
    policyAccepted: accepted.by === "customer",
    policyAcceptedAt: accepted.by === "customer" ? accepted.at : null,
    eventTime: more.eventTime,
    guestCount: more.guestCount,
    package: more.package?.name ?? null,
    items: bookingItemLines(more.units, more.gigs),
    balance: owed.money.balanceDueCents === null ? null : owed.money.balanceDueCents / 100,
    balanceDueDate: owed.money.totalCents === null ? null : daysBefore(b.eventDate.toISOString().slice(0, 10), owed.settings.balanceDueDays),
    hasAccount: b.customer !== null,
  });
});

// Block F3b. The customer ticked the policy box on the pay screen. Records the
// time and the exact version and text on the booking. Send the id of the
// policy the screen showed, so a policy saved in between is caught.
payApiRouter.post("/:token/policy", async (req, res) => {
  const found = await bookingByToken(String(req.params.token));
  if (!found) return res.status(404).json({ error: "That pay link isn't known.", reason: "not-found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.accept !== true) return res.status(400).json({ error: "Send accept: true when the customer ticks the policy box.", reason: "accept-required", field: "accept" });
  if (body.policyId !== undefined && body.policyId !== null && (typeof body.policyId !== "string" || body.policyId.length > 60)) return res.status(400).json({ error: "policyId must be the id of the policy shown.", reason: "policy-invalid", field: "policyId" });
  const result = await acceptPolicy(found.id, { policyId: typeof body.policyId === "string" ? body.policyId : null });
  res.setHeader("Cache-Control", "no-store");
  if (!result.ok) return res.status(result.status).json({ error: result.error, reason: result.reason, ...(result.policy ? { policy: result.policy } : {}) });
  res.status(result.created ? 201 : 200).json({ policyAccepted: true, policyAcceptedAt: result.acceptedAt.toISOString(), policyVersion: result.version });
});

// An embedded Checkout Session for what is owed, the same as the signed-in
// portal's call, reached by the token instead of the session cookie.
payApiRouter.post("/:token/session", async (req, res) => {
  const found = await bookingByToken(String(req.params.token));
  if (!found) return res.status(404).json({ error: "That pay link isn't known.", reason: "not-found" });
  try {
    const owed = await owedFor(found.id);
    if (owed.step === "sign") return res.status(409).json({ error: "Sign the contract first, then the retainer.", reason: "not-payable" });
    if (owed.step !== "retainer" && owed.step !== "balance") return res.status(409).json({ error: "Nothing is due right now.", reason: "nothing-due" });
    const offer = await createPaymentSession(found.id, owed.step);
    if (!offer) return res.status(409).json({ error: "Online payment is not set up yet. GO will follow up to collect it.", reason: "not-payable" });
    res.json({ clientSecret: offer.clientSecret, sessionId: offer.sessionId, amount: offer.amount, kind: offer.kind });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message, reason: err.reason });
    if (err instanceof StripeError) return res.status(502).json({ error: "The payment could not be started. Try again in a moment.", reason: "stripe" });
    throw err;
  }
});
