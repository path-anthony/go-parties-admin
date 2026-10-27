import { actorFields } from "./actor.js";
import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";
import { queueGoogleSync } from "./google/sync.js";
import { safeErr } from "./log.js";
import { notifyStageChange } from "./notify.js";
import { getSettings } from "./settings.js";
import { createCheckoutSession, createRefund, createStripeCustomer, retrieveCheckoutSession, stripeConfigured, stripeRequest, StripeError, type CheckoutSession, type StripeEventBody } from "./stripe/client.js";
import { tier1Amount } from "./tiers.js";
import { displayStatus } from "../src/lib/bookingStatus.js";

// Block T1. Money on a booking. Every amount is computed here from the
// booking, its signed contract and the payments already recorded; a browser
// never names an amount. Stripe tells us a payment succeeded by webhook (or
// by the status check retrieving the session from Stripe); only then is
// anything marked paid.

export const PAYMENT_KINDS = ["retainer", "balance", "other"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const MANUAL_METHODS = ["cash", "check", "other"] as const;

export class PaymentError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

type PaymentRow = { kind: string; status: string; amountCents: number; refundedCents: number };

export type Money = {
  // The contract total (tier 2) or the quoted total, in cents. Null when
  // nothing was priced.
  totalCents: number | null;
  retainerDueCents: number | null;
  retainerPaidCents: number;
  paidCents: number;
  balanceDueCents: number | null;
  retainerPaid: boolean;
  balancePaid: boolean;
};

export type MoneyBooking = {
  tier: number | null;
  total: unknown;
  retainerPaid: boolean;
  balancePaid: boolean;
  agreement?: { contractDocument?: { documentJson: unknown } | null } | null;
};

// Pure. What is owed and what was paid.
export function amountsFor(b: MoneyBooking, payments: PaymentRow[], settings: { depositPercentage: number; tier1Collect: string }): Money {
  const doc = (b.agreement?.contractDocument?.documentJson ?? null) as { payment?: { total?: unknown; retainerAmount?: unknown } } | null;
  const docTotal = typeof doc?.payment?.total === "number" ? (doc.payment.total as number) : null;
  const docRetainer = typeof doc?.payment?.retainerAmount === "number" ? (doc.payment.retainerAmount as number) : null;
  const quoted = b.total === null || b.total === undefined ? null : Math.round(Number(b.total) * 100);
  const totalCents = b.tier === 2 && docTotal !== null ? docTotal : quoted;
  const live = payments.filter((p) => p.status === "succeeded" || p.status === "refunded" || p.status === "disputed");
  const net = (p: PaymentRow) => Math.max(0, p.amountCents - p.refundedCents);
  const retainerPaidCents = live.filter((p) => p.kind === "retainer").reduce((s, p) => s + net(p), 0);
  const paidCents = live.reduce((s, p) => s + net(p), 0);
  let retainerDueCents: number | null = null;
  if (totalCents !== null) {
    if (b.tier === 2 && docRetainer !== null) retainerDueCents = docRetainer;
    else retainerDueCents = Math.round(tier1Amount(totalCents / 100, settings.depositPercentage, settings.tier1Collect === "full" ? "full" : "retainer") * 100);
  }
  const retainerPaid = b.retainerPaid || (retainerDueCents !== null && retainerDueCents > 0 && retainerPaidCents >= retainerDueCents);
  // The balance is what is left once the retainer is accounted for: the
  // contract's "balance" before the retainer is paid, the real remainder after.
  const retainerStillDue = retainerPaid ? 0 : Math.max(0, (retainerDueCents ?? 0) - retainerPaidCents);
  const balanceDueCents = totalCents === null ? null : Math.max(0, totalCents - paidCents - retainerStillDue);
  const balancePaid = b.balancePaid || (totalCents !== null && totalCents > 0 && paidCents >= totalCents);
  return { totalCents, retainerDueCents, retainerPaidCents, paidCents, balanceDueCents, retainerPaid, balancePaid };
}

const PAYMENT_INCLUDE = {
  agreement: { select: { id: true, contractStatus: true, contractDocument: { select: { documentJson: true } } } },
  payments: { orderBy: { createdAt: "asc" as const } },
  customer: { select: { id: true, name: true, email: true, stripeCustomerId: true } },
} as const;

export async function loadMoney(bookingId: string): Promise<{ booking: NonNullable<Awaited<ReturnType<typeof loadBooking>>>; money: Money; settings: Awaited<ReturnType<typeof getSettings>> }> {
  const booking = await loadBooking(bookingId);
  if (!booking) throw new PaymentError(404, "not-found", "booking not found");
  const settings = await getSettings(booking.accountId);
  return { booking, money: amountsFor(booking, booking.payments, settings), settings };
}

function loadBooking(bookingId: string) {
  return prisma.booking.findUnique({ where: { id: bookingId }, include: PAYMENT_INCLUDE });
}

const inactive = (status: string) => status === "Cancelled" || status === "Released" || status === "Completed";

export type PaymentOffer = { kind: "retainer" | "balance"; amount: number; clientSecret: string; sessionId: string };

// What a kind can collect right now, in cents, or why not.
export function dueFor(b: { status: string; tier: number | null; agreement?: { contractStatus: string | null } | null }, money: Money, kind: "retainer" | "balance"): { cents: number } | { reason: "nothing-due" | "not-payable"; message: string } {
  if (inactive(b.status)) return { reason: "not-payable", message: "This booking is no longer open for payment." };
  if (kind === "retainer") {
    if (money.retainerPaid || money.retainerDueCents === null || money.retainerDueCents <= money.retainerPaidCents) return { reason: "nothing-due", message: "Nothing is due right now." };
    if (b.tier === 2 && b.agreement?.contractStatus !== "Signed") return { reason: "not-payable", message: "Sign the contract first, then the retainer." };
    return { cents: money.retainerDueCents - money.retainerPaidCents };
  }
  if (!money.retainerPaid) return { reason: "not-payable", message: "Online payment is not open for this yet." };
  if (money.balancePaid || money.balanceDueCents === null || money.balanceDueCents <= 0) return { reason: "nothing-due", message: "Nothing is due right now." };
  return { cents: money.balanceDueCents };
}

async function stripeCustomerFor(b: NonNullable<Awaited<ReturnType<typeof loadBooking>>>): Promise<string | null> {
  if (b.customer?.stripeCustomerId) return b.customer.stripeCustomerId;
  if (b.stripeCustomerId) return b.stripeCustomerId;
  const email = b.customer?.email ?? b.email;
  if (!email) return null;
  const key = b.customer ? `cust:${b.customer.id}` : `cust:booking:${b.id}`;
  const c = await createStripeCustomer({ email, name: b.customer?.name ?? b.customerName, metadata: { goCustomerId: b.customer?.id ?? "", goBookingId: b.id }, idempotencyKey: key });
  if (b.customer) await prisma.customer.update({ where: { id: b.customer.id }, data: { stripeCustomerId: c.id } });
  else await prisma.booking.update({ where: { id: b.id }, data: { stripeCustomerId: c.id } });
  return c.id;
}

// Mints a Checkout Session for what is due. Null when Stripe is not set up.
// Throws PaymentError (409) when nothing is due or it is not payable yet.
export async function createPaymentSession(bookingId: string, kind: "retainer" | "balance"): Promise<PaymentOffer | null> {
  if (!stripeConfigured()) return null;
  const { booking, money, settings } = await loadMoney(bookingId);
  const due = dueFor(booking, money, kind);
  if ("reason" in due) throw new PaymentError(409, due.reason, due.message);
  // An earlier session for the same thing is expired on Stripe's side, best
  // effort, so the customer cannot pay the same amount twice.
  for (const old of booking.payments.filter((p) => p.kind === kind && p.status === "pending" && p.stripeSessionId)) {
    await stripeRequest("POST", `/v1/checkout/sessions/${encodeURIComponent(old.stripeSessionId as string)}/expire`).catch(() => undefined);
    await prisma.payment.update({ where: { id: old.id }, data: { status: "expired" } });
  }
  const customerId = await stripeCustomerFor(booking);
  const row = await prisma.payment.create({
    data: { accountId: booking.accountId, bookingId: booking.id, agreementId: booking.agreement?.id ?? null, kind, amountCents: due.cents, method: "card", status: "pending" },
  });
  const label = kind === "retainer" ? (settings.tier1Collect === "full" && booking.tier !== 2 ? "Payment in full" : "Retainer") : "Balance";
  let session: CheckoutSession;
  try {
    session = await createCheckoutSession({
      amountCents: due.cents,
      name: `${settings.contractCompanyName}: ${label}`,
      description: `Booking for ${booking.eventDate.toISOString().slice(0, 10)}`,
      customerId,
      customerEmail: customerId ? null : (booking.email ?? null),
      metadata: { bookingId: booking.id, agreementId: booking.agreement?.id ?? "", kind, paymentId: row.id },
      idempotencyKey: `sess:${row.id}`,
      saveCard: settings.saveCardForBalance,
    });
  } catch (err) {
    await prisma.payment.update({ where: { id: row.id }, data: { status: "failed", failureReason: err instanceof StripeError ? err.message : safeErr(err) } });
    await prisma.account.update({ where: { id: booking.accountId }, data: { stripeLastError: `session: ${err instanceof StripeError ? err.message : safeErr(err)}`.slice(0, 300) } });
    throw err;
  }
  await prisma.payment.update({ where: { id: row.id }, data: { stripeSessionId: session.id, stripePaymentIntentId: session.payment_intent ?? null } });
  if (!session.client_secret) throw new PaymentError(502, "no-secret", "Stripe did not return a client secret.");
  return { kind, amount: due.cents / 100, clientSecret: session.client_secret, sessionId: session.id };
}

// ---- marking paid ----------------------------------------------------------------

// A succeeded payment changes the booking: the retainer flag (which is what
// Retainer Paid and Confirmed read), the balance flag, a line on the lead,
// the stage messages and the calendar. Idempotent: a payment already
// succeeded does nothing.
export async function settlePayment(paymentId: string, detail: { paymentIntentId?: string | null; chargeId?: string | null; paidAt?: Date } = {}): Promise<boolean> {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p || p.status === "succeeded" || p.status === "refunded" || p.status === "disputed") return false;
  await prisma.payment.update({
    where: { id: p.id },
    data: { status: "succeeded", paidAt: detail.paidAt ?? new Date(), stripePaymentIntentId: detail.paymentIntentId ?? p.stripePaymentIntentId, stripeChargeId: detail.chargeId ?? p.stripeChargeId },
  });
  await applyPaid(p.bookingId);
  return true;
}

export async function applyPaid(bookingId: string): Promise<void> {
  const { booking, money } = await loadMoney(bookingId);
  const before = displayStatus(booking);
  const data: { retainerPaid?: boolean; balancePaid?: boolean } = {};
  if (money.retainerPaid && !booking.retainerPaid) data.retainerPaid = true;
  if (money.balancePaid && !booking.balancePaid) data.balancePaid = true;
  if (Object.keys(data).length === 0) return;
  const updated = await prisma.booking.update({ where: { id: bookingId }, data });
  if (booking.leadId) {
    const what = [data.retainerPaid ? "retainer" : null, data.balancePaid ? "balance" : null].filter(Boolean).join(" and ");
    await prisma.leadActivity.create({ data: { leadId: booking.leadId, text: `Payment received: ${what} paid.`, ...actorFields() } }).catch(() => undefined);
  }
  void notifyStageChange(bookingId, before, displayStatus(updated));
  queueGoogleSync(bookingId);
}

// Staff recorded money taken outside Stripe.
export async function recordManualPayment(bookingId: string, input: { kind: PaymentKind; amountCents: number; method: string; note: string | null }) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, accountId: true, agreement: { select: { id: true } } } });
  if (!b) throw new PaymentError(404, "not-found", "booking not found");
  const who = actorFields();
  const row = await prisma.payment.create({
    data: {
      accountId: b.accountId,
      bookingId: b.id,
      agreementId: b.agreement?.id ?? null,
      kind: input.kind,
      amountCents: input.amountCents,
      method: input.method,
      status: "succeeded",
      note: input.note,
      paidAt: new Date(),
      recordedById: who.userId ?? null,
      recordedByName: who.userName ?? null,
    },
  });
  await applyPaid(b.id);
  return row;
}

// A partial or full refund of a card payment, through Stripe. The local row
// is updated at once; the charge.refunded webhook confirms it later.
export async function refundPayment(paymentId: string, amountCents: number, note: string | null) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw new PaymentError(404, "not-found", "payment not found");
  if (p.method !== "card" || !p.stripePaymentIntentId) throw new PaymentError(409, "not-refundable", "Only card payments taken through Stripe can be refunded here.");
  if (p.status !== "succeeded" && p.status !== "refunded") throw new PaymentError(409, "not-refundable", "That payment has not succeeded.");
  const remaining = p.amountCents - p.refundedCents;
  if (amountCents <= 0 || amountCents > remaining) throw new PaymentError(400, "bad-amount", `The refund must be between $0.01 and $${(remaining / 100).toFixed(2)}.`);
  const who = actorFields();
  const refund = await createRefund({ paymentIntentId: p.stripePaymentIntentId, amountCents, idempotencyKey: `refund:${p.id}:${p.refundedCents + amountCents}`, reason: note ?? "" });
  const refunded = p.refundedCents + amountCents;
  const updated = await prisma.payment.update({
    where: { id: p.id },
    data: { refundedCents: refunded, status: refunded >= p.amountCents ? "refunded" : "succeeded", note: [p.note, note ? `Refund ${(amountCents / 100).toFixed(2)}: ${note}` : null].filter(Boolean).join(" | ") || null },
  });
  const b = await prisma.booking.findUnique({ where: { id: p.bookingId }, select: { leadId: true } });
  if (b?.leadId) await prisma.leadActivity.create({ data: { leadId: b.leadId, text: `Refunded $${(amountCents / 100).toFixed(2)} of a ${p.kind} payment${who.userName ? "" : ""}.`, ...who } }).catch(() => undefined);
  return { payment: updated, refundId: refund.id };
}

// ---- the status check --------------------------------------------------------------

export type PaymentStatusView = { status: "complete" | "open" | "expired"; paid: boolean; bookingId: string | null; kind: string | null };

// What the storefront polls after the embedded form reports completion. Our
// own record first; while it is still pending the session is retrieved from
// Stripe, and a session Stripe says is complete and paid is settled here as
// well, so a late webhook never leaves a paid customer waiting.
export async function paymentStatus(sessionId: string): Promise<PaymentStatusView | null> {
  const p = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId } });
  if (!p) return null;
  const view = (status: PaymentStatusView["status"], paid: boolean): PaymentStatusView => ({ status, paid, bookingId: p.bookingId, kind: p.kind });
  if (p.status === "succeeded" || p.status === "refunded" || p.status === "disputed") return view("complete", true);
  if (p.status === "expired" || p.status === "failed") return view("expired", false);
  if (!stripeConfigured()) return view("open", false);
  try {
    const s = await retrieveCheckoutSession(sessionId);
    if (s.status === "complete" && s.payment_status === "paid") {
      await settlePayment(p.id, { paymentIntentId: s.payment_intent });
      return view("complete", true);
    }
    if (s.status === "expired") {
      await prisma.payment.update({ where: { id: p.id }, data: { status: "expired" } });
      return view("expired", false);
    }
    if (s.status === "complete") return view("complete", false);
  } catch (err) {
    console.warn("[payments] status check could not reach Stripe:", safeErr(err));
  }
  return view("open", false);
}

// ---- webhooks ------------------------------------------------------------------

type Session = { id: string; payment_status?: string; payment_intent?: string | null; metadata?: Record<string, string> };
type Charge = { id: string; payment_intent?: string | null; amount_refunded?: number; refunded?: boolean };
type Dispute = { id: string; payment_intent?: string | null; charge?: string | null; reason?: string; amount?: number };
type PaymentIntent = { id: string; last_payment_error?: { message?: string } | null; metadata?: Record<string, string> };

async function paymentByIntent(intentId: string | null | undefined) {
  if (!intentId) return null;
  return prisma.payment.findFirst({ where: { stripePaymentIntentId: intentId } });
}

// Records the event once (by Stripe's id) and applies it. A replay returns
// duplicate: true and changes nothing.
export async function applyStripeEvent(event: StripeEventBody): Promise<{ duplicate: boolean; handled: boolean; error?: string }> {
  const account = await getDefaultAccount();
  try {
    await prisma.stripeEvent.create({ data: { id: event.id, accountId: account.id, type: event.type, payload: event as object } });
  } catch (err) {
    if ((err as { code?: unknown }).code === "P2002") return { duplicate: true, handled: false };
    throw err;
  }
  await prisma.account.update({ where: { id: account.id }, data: { stripeLastWebhookAt: new Date(), stripeLastError: null } });
  let handled = true;
  let error: string | undefined;
  try {
    const obj = event.data.object as Record<string, unknown>;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = obj as unknown as Session;
        const p = await prisma.payment.findUnique({ where: { stripeSessionId: s.id } });
        if (!p) throw new Error("no payment for that session");
        if (s.payment_status === "paid") await settlePayment(p.id, { paymentIntentId: s.payment_intent ?? null });
        else await prisma.payment.update({ where: { id: p.id }, data: { stripePaymentIntentId: s.payment_intent ?? p.stripePaymentIntentId, status: p.status === "pending" ? "processing" : p.status } });
        break;
      }
      case "checkout.session.async_payment_failed": {
        const s = obj as unknown as Session;
        await prisma.payment.updateMany({ where: { stripeSessionId: s.id, status: { in: ["pending", "processing"] } }, data: { status: "failed", failureReason: "The payment did not go through." } });
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = obj as unknown as PaymentIntent;
        const p = (await paymentByIntent(pi.id)) ?? (pi.metadata?.paymentId ? await prisma.payment.findUnique({ where: { id: pi.metadata.paymentId } }) : null);
        if (p && p.status !== "succeeded") await prisma.payment.update({ where: { id: p.id }, data: { failureReason: (pi.last_payment_error?.message ?? "The payment did not go through.").slice(0, 300), stripePaymentIntentId: pi.id } });
        break;
      }
      case "charge.refunded": {
        const c = obj as unknown as Charge;
        const p = await paymentByIntent(c.payment_intent);
        if (!p) throw new Error("no payment for that charge");
        const refunded = Math.min(p.amountCents, c.amount_refunded ?? 0);
        await prisma.payment.update({ where: { id: p.id }, data: { refundedCents: refunded, stripeChargeId: c.id, status: refunded >= p.amountCents ? "refunded" : p.status } });
        break;
      }
      case "charge.dispute.created": {
        const d = obj as unknown as Dispute;
        const p = await paymentByIntent(d.payment_intent);
        if (!p) throw new Error("no payment for that dispute");
        await prisma.payment.update({ where: { id: p.id }, data: { status: "disputed", failureReason: `Disputed: ${d.reason ?? "no reason given"}`.slice(0, 300) } });
        await prisma.booking.update({ where: { id: p.bookingId }, data: { disputeFlaggedAt: new Date(), disputeNote: `A ${p.kind} payment of $${(p.amountCents / 100).toFixed(2)} was disputed (${d.reason ?? "no reason given"}).`.slice(0, 300) } });
        const b = await prisma.booking.findUnique({ where: { id: p.bookingId }, select: { leadId: true } });
        if (b?.leadId) await prisma.leadActivity.create({ data: { leadId: b.leadId, text: `Payment disputed with the card company: ${p.kind}, $${(p.amountCents / 100).toFixed(2)}. Owners should look at this.` } }).catch(() => undefined);
        break;
      }
      default:
        handled = false;
    }
  } catch (err) {
    error = safeErr(err);
    await prisma.account.update({ where: { id: account.id }, data: { stripeLastError: `${event.type}: ${error}`.slice(0, 300) } });
  }
  await prisma.stripeEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: error ?? null } });
  return { duplicate: false, handled, error };
}

// For the Integrations card.
export async function stripeStatus(accountId: string) {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { stripeLastWebhookAt: true, stripeLastError: true } });
  return { lastWebhookAt: a.stripeLastWebhookAt, lastError: a.stripeLastError };
}
