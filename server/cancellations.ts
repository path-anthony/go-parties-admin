import { actorFields } from "./actor.js";
import { cancelBooking } from "./bookingOps.js";
import { prisma } from "./db.js";
import { queueGoogleSync } from "./google/sync.js";
import { safeErr } from "./log.js";
import { clearCancellationAlert, notifyCancellationRequest } from "./notifications.js";
import { amountsFor } from "./payments.js";
import { currentPolicy } from "./policy.js";
import { safeInline } from "./sanitize.js";
import { sendTemplatedMessage } from "./sendTemplated.js";
import { getSettings } from "./settings.js";

// Block F1. Cancellation requests and the refund log.
//
// A customer cannot cancel a booking. They ask, with a reason; when a
// retainer has been paid they are shown the retainer terms and must accept
// them, and what they saw is stored. The booking, its date and its units stay
// exactly as they were until staff approve or decline.
//
// The refund log is a record only. Nothing in this file moves money or calls
// Stripe: a refund is made by a person in Stripe and then written down here.

export const CANCEL_TAG = "Cancellation request";
export const MAX_REASON = 1000;
export const REFUND_METHODS = ["stripe", "check", "cash", "other"] as const;

export type RetainerTerms = { source: "contract" | "policy"; title: string; text: string; policyVersionId: string | null };

type TermsBooking = {
  accountId: string;
  tier: number | null;
  agreement?: { policyVersion?: { id: string; text: string } | null; contractStatus: string | null; contractDocument?: { documentJson: unknown } | null } | null;
};

// The retainer terms the customer agreed to, in this order: the retainer and
// cancellation clauses of their own signed contract; the rental policy
// version on their booking; the current rental policy. Null when there is no
// text anywhere (the policy has never been written).
export async function retainerTermsFor(b: TermsBooking): Promise<RetainerTerms | null> {
  const doc = (b.agreement?.contractDocument?.documentJson ?? null) as { terms?: { clauses?: { title?: unknown; body?: unknown }[] } } | null;
  if (b.agreement?.contractStatus === "Signed" && Array.isArray(doc?.terms?.clauses)) {
    const picked = doc.terms.clauses.filter((c) => typeof c.title === "string" && typeof c.body === "string" && /retainer|cancel/i.test(c.title));
    if (picked.length > 0) {
      return { source: "contract", title: "From your signed contract", text: picked.map((c) => `${c.title as string}. ${c.body as string}`).join("\n\n"), policyVersionId: null };
    }
  }
  const own = b.agreement?.policyVersion;
  if (own && own.text.trim() !== "") return { source: "policy", title: "Cancellation and retainer policy", text: own.text, policyVersionId: own.id };
  const current = await currentPolicy(b.accountId);
  if (current.text.trim() === "") return null;
  return { source: "policy", title: "Cancellation and retainer policy", text: current.text, policyVersionId: current.id };
}

const REQUEST_BOOKING = {
  agreement: { select: { contractStatus: true, policyVersion: { select: { id: true, text: true } }, contractDocument: { select: { documentJson: true } } } },
  payments: true,
} as const;

// What the storefront shows before the customer asks: what they have paid,
// the terms when a retainer was paid, and a request already waiting.
export async function cancellationPreview(bookingId: string) {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { ...REQUEST_BOOKING, cancellationRequests: { where: { status: "Open" }, take: 1 } } });
  const settings = await getSettings(b.accountId);
  const money = amountsFor(b, b.payments, settings);
  const termsRequired = money.retainerPaid || money.paidCents > 0;
  return { booking: b, money, termsRequired, terms: termsRequired ? await retainerTermsFor(b) : null, open: b.cancellationRequests[0] ?? null };
}

export type CancelAsk =
  | { ok: true; created: boolean; request: { id: string; status: string; reason: string | null; createdAt: Date; termsAcceptedAt: Date | null }; terms: RetainerTerms | null; paidCents: number }
  | { ok: false; reason: "terms-required"; terms: RetainerTerms | null; paidCents: number };

// The customer asks to cancel. Frees nothing and changes nothing on the
// booking. Asking twice returns the request that is already open.
export async function requestCancellation(bookingId: string, input: { reason: string | null; acceptTerms: boolean; customerId: string | null }): Promise<CancelAsk> {
  const { booking: b, money, termsRequired, terms, open } = await cancellationPreview(bookingId);
  if (open) return { ok: true, created: false, request: open, terms, paidCents: money.paidCents };
  if (termsRequired && !input.acceptTerms) return { ok: false, reason: "terms-required", terms, paidCents: money.paidCents };
  const reason = input.reason ? safeInline(input.reason, MAX_REASON) || null : null;
  const request = await prisma.cancellationRequest.create({
    data: {
      accountId: b.accountId,
      bookingId: b.id,
      customerId: input.customerId,
      reason,
      paidCents: money.paidCents,
      termsAcceptedAt: termsRequired ? new Date() : null,
      termsPolicyVersionId: termsRequired ? (terms?.policyVersionId ?? null) : null,
      termsText: termsRequired ? (terms?.text ?? null) : null,
    },
  });
  if (b.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: b.leadId }, select: { tags: true } });
    await prisma.lead.update({ where: { id: b.leadId }, data: { tags: [...new Set([...(lead?.tags ?? []), CANCEL_TAG])] } }).catch(() => undefined);
    await prisma.leadActivity
      .create({ data: { leadId: b.leadId, text: `The customer asked to cancel this booking${reason ? `: "${reason}"` : " (no reason given)"}. ${termsRequired ? "They were shown the retainer terms and accepted them. " : ""}Nothing is cancelled until staff approve it.` } })
      .catch(() => undefined);
  }
  await notifyCancellationRequest({ id: request.id, accountId: b.accountId, paidCents: money.paidCents, booking: { id: b.id, customerName: b.customerName, eventDate: b.eventDate, leadId: b.leadId, customerId: b.customerId } });
  return { ok: true, created: true, request, terms, paidCents: money.paidCents };
}

export class CancellationError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function untag(leadId: string | null) {
  if (!leadId) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true } });
  if (lead?.tags.includes(CANCEL_TAG)) await prisma.lead.update({ where: { id: leadId }, data: { tags: lead.tags.filter((t) => t !== CANCEL_TAG) } }).catch(() => undefined);
}

// Staff decide. Approve: the booking is cancelled and its units and crew
// gigs are freed. Decline: the booking is left exactly as it is. Either way
// the customer is told by email (once), the lead is noted and the alert is
// settled. Only the first decision on a request counts.
export async function decideCancellation(requestId: string, accountId: string, decision: "approve" | "decline", note: string | null) {
  const request = await prisma.cancellationRequest.findFirst({ where: { id: requestId, accountId }, include: { booking: { select: { id: true, leadId: true, email: true, status: true } } } });
  if (!request) throw new CancellationError(404, "not-found", "That cancellation request was not found.");
  const who = actorFields();
  const won = await prisma.cancellationRequest.updateMany({
    where: { id: request.id, status: "Open" },
    data: { status: decision === "approve" ? "Approved" : "Declined", decidedAt: new Date(), decidedByName: who.userName ?? "staff", decisionNote: note },
  });
  if (won.count === 0) throw new CancellationError(409, "already-decided", "That request was already decided.");
  const b = request.booking;
  const by = who.userName ? ` by ${who.userName}` : "";
  if (decision === "approve") {
    if (b.status !== "Cancelled" && b.status !== "Released") await cancelBooking(b.id, `Cancellation request approved${by}. The booking is cancelled and its items are free again.${note ? ` Note: ${note}` : ""}`);
    queueGoogleSync(b.id);
  } else if (b.leadId) {
    await prisma.leadActivity.create({ data: { leadId: b.leadId, text: `Cancellation request declined${by}. The booking is unchanged.${note ? ` Note: ${note}` : ""}`, ...who } }).catch(() => undefined);
  }
  await untag(b.leadId);
  await clearCancellationAlert(request.id);
  let told = false;
  try {
    const trigger = decision === "approve" ? "cancellation_approved" : "cancellation_declined";
    const outcomes = await sendTemplatedMessage(trigger, { bookingId: b.id }, { email: b.email }, `${trigger}:${request.id}`, { channels: ["email"], purpose: "cancellation-decision" });
    told = outcomes.some((o) => o.status === "sent");
    if (told) await prisma.cancellationRequest.update({ where: { id: request.id }, data: { customerToldAt: new Date() } });
  } catch (err) {
    console.warn("[cancellations] the customer was not told:", safeErr(err));
  }
  return { id: request.id, status: decision === "approve" ? "Approved" : "Declined", customerTold: told };
}

// ---- the refund log ----------------------------------------------------------------

// Writes down a refund that staff made somewhere else. A record only.
export async function addRefundRecord(bookingId: string, accountId: string, input: { amountCents: number; refundedOn: Date; method: string; note: string | null; cancellationRequestId: string | null }) {
  const b = await prisma.booking.findFirst({ where: { id: bookingId, accountId }, select: { id: true, leadId: true } });
  if (!b) throw new CancellationError(404, "not-found", "booking not found");
  const who = actorFields();
  const row = await prisma.refundRecord.create({
    data: { accountId, bookingId: b.id, cancellationRequestId: input.cancellationRequestId, amountCents: input.amountCents, refundedOn: input.refundedOn, method: input.method, note: input.note, recordedByName: who.userName ?? null },
  });
  if (b.leadId) {
    await prisma.leadActivity
      .create({ data: { leadId: b.leadId, text: `Refund written in the log: $${(input.amountCents / 100).toFixed(2)} by ${input.method}, ${input.refundedOn.toISOString().slice(0, 10)}. This is a record; the refund itself is made in Stripe.`, ...who } })
      .catch(() => undefined);
  }
  return row;
}

export const serializeRefund = (r: { id: string; amountCents: number; refundedOn: Date; method: string; note: string | null; recordedByName: string | null; createdAt: Date; cancellationRequestId: string | null }) => ({
  id: r.id,
  amountCents: r.amountCents,
  refundedOn: r.refundedOn.toISOString().slice(0, 10),
  method: r.method,
  note: r.note,
  recordedByName: r.recordedByName,
  createdAt: r.createdAt.toISOString(),
  cancellationRequestId: r.cancellationRequestId,
});

// For the admin: one request with everything staff need to decide.
export const ADMIN_REQUEST_INCLUDE = {
  booking: {
    select: {
      id: true,
      customerName: true,
      phone: true,
      email: true,
      eventDate: true,
      eventTime: true,
      status: true,
      tier: true,
      total: true,
      retainerPaid: true,
      balancePaid: true,
      confirmedAt: true,
      leadId: true,
      agreement: { select: { contractStatus: true, contractDocument: { select: { documentJson: true } } } },
      payments: true,
      refundRecords: { orderBy: { createdAt: "asc" as const } },
    },
  },
} as const;

type AdminRequestRow = {
  id: string;
  status: string;
  reason: string | null;
  paidCents: number;
  termsAcceptedAt: Date | null;
  termsText: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionNote: string | null;
  customerToldAt: Date | null;
  createdAt: Date;
  booking: {
    id: string;
    customerName: string;
    phone: string | null;
    email: string | null;
    eventDate: Date;
    eventTime: string | null;
    status: string;
    tier: number | null;
    total: unknown;
    retainerPaid: boolean;
    balancePaid: boolean;
    confirmedAt: Date | null;
    leadId: string | null;
    agreement: { contractStatus: string | null; contractDocument: { documentJson: unknown } | null } | null;
    payments: { kind: string; status: string; amountCents: number; refundedCents: number }[];
    refundRecords: Parameters<typeof serializeRefund>[0][];
  };
};

export function serializeRequest(r: AdminRequestRow, settings: { depositPercentage: number; tier1Collect: string }) {
  const money = amountsFor(r.booking, r.booking.payments, settings);
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    paidAtRequestCents: r.paidCents,
    paidCents: money.paidCents,
    retainerPaidCents: money.retainerPaidCents,
    termsAcceptedAt: r.termsAcceptedAt?.toISOString() ?? null,
    termsText: r.termsText,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedByName: r.decidedByName,
    decisionNote: r.decisionNote,
    customerToldAt: r.customerToldAt?.toISOString() ?? null,
    booking: {
      id: r.booking.id,
      customerName: r.booking.customerName,
      phone: r.booking.phone,
      email: r.booking.email,
      eventDate: r.booking.eventDate.toISOString().slice(0, 10),
      eventTime: r.booking.eventTime,
      status: r.booking.status,
      retainerPaid: r.booking.retainerPaid,
      confirmedAt: r.booking.confirmedAt?.toISOString() ?? null,
      leadId: r.booking.leadId,
      totalCents: money.totalCents,
    },
    refunds: r.booking.refundRecords.map(serializeRefund),
  };
}
