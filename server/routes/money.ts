import { Router, type Response } from "express";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { ADMIN_REQUEST_INCLUDE, CancellationError, REFUND_METHODS, addRefundRecord, decideCancellation, serializeRefund, serializeRequest } from "../cancellations.js";
import { daysBefore } from "../contract/goMoney.js";
import { prisma } from "../db.js";
import { owedFor, owedStep, payLinkFor, ensurePayToken, sendPayLink } from "../payLink.js";
import { PaymentError, amountsFor } from "../payments.js";
import { getSettings } from "../settings.js";
import { INVALID, normalizeDate, todayEastern } from "../validate.js";
import { displayStatus } from "../../src/lib/bookingStatus.js";

// Block F1. The staff side of the money path: the Send pay link button, the
// refund log, cancellation requests, and the two Overview sections.

function fail(res: Response, err: unknown) {
  if (err instanceof CancellationError || err instanceof PaymentError) return res.status(err.status).json({ error: err.message, reason: err.reason });
  throw err;
}

async function own(id: string) {
  const account = await getDefaultAccount();
  return prisma.booking.findFirst({ where: { id, accountId: account.id }, select: { id: true, accountId: true } });
}

// ---- on a booking: /api/bookings/:id/... -----------------------------------------

export const bookingMoneyRouter = Router();

const WORD: Record<string, string> = { sign: "The contract is not signed yet, so this sends the contract link and says the retainer amount.", retainer: "The retainer is owed.", balance: "The balance is owed.", nothing: "Nothing is owed on this booking right now.", closed: "This booking is cancelled or finished, so nothing is owed." };

async function payLinkView(bookingId: string) {
  const owed = await owedFor(bookingId);
  const b = owed.booking;
  return {
    step: owed.step,
    amountCents: owed.amountCents,
    explain: WORD[owed.step],
    canSend: owed.step === "sign" || owed.step === "retainer" || owed.step === "balance",
    link: payLinkFor(await ensurePayToken(bookingId)),
    hasPhone: Boolean(b.phone),
    hasEmail: Boolean(b.email),
    lastSentAt: b.payLinkSentAt?.toISOString() ?? null,
    lastSentByName: b.payLinkSentByName,
    retainerRequestedAt: b.retainerRequestedAt?.toISOString() ?? null,
  };
}

bookingMoneyRouter.get("/:id/pay-link", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  try {
    res.json(await payLinkView(b.id));
  } catch (err) {
    fail(res, err);
  }
});

// Sends whichever is owed, by text and email. Every send is in the Sent log.
bookingMoneyRouter.post("/:id/pay-link/send", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  try {
    const sent = await sendPayLink(b.id, "manual");
    res.status(sent.sent ? 200 : 409).json({ sent: sent.sent, why: sent.why, ...(await payLinkView(b.id)) });
  } catch (err) {
    fail(res, err);
  }
});

bookingMoneyRouter.get("/:id/refunds", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  const rows = await prisma.refundRecord.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: "asc" } });
  res.json({ refunds: rows.map(serializeRefund) });
});

// The refund log. A record only: nothing here moves money.
bookingMoneyRouter.post("/:id/refunds", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const amountCents = body.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) return res.status(400).json({ error: "Enter the amount refunded, above $0." });
  const refundedOn = normalizeDate(body.refundedOn);
  if (refundedOn === INVALID || refundedOn === null) return res.status(400).json({ error: "Enter the date the refund was made." });
  if (!(REFUND_METHODS as readonly unknown[]).includes(body.method)) return res.status(400).json({ error: `method must be one of ${REFUND_METHODS.join(", ")}` });
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  let cancellationRequestId: string | null = null;
  if (typeof body.cancellationRequestId === "string") {
    const r = await prisma.cancellationRequest.findFirst({ where: { id: body.cancellationRequestId, bookingId: b.id }, select: { id: true } });
    if (!r) return res.status(400).json({ error: "That cancellation request is not on this booking." });
    cancellationRequestId = r.id;
  }
  try {
    await addRefundRecord(b.id, b.accountId, { amountCents, refundedOn, method: body.method as string, note, cancellationRequestId });
    const rows = await prisma.refundRecord.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: "asc" } });
    res.status(201).json({ refunds: rows.map(serializeRefund) });
  } catch (err) {
    fail(res, err);
  }
});

// ---- cancellation requests: /api/cancellation-requests ---------------------------

export const cancellationRequestsRouter = Router();

cancellationRequestsRouter.get("/", async (req, res) => {
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  const status = typeof req.query.status === "string" && ["Open", "Approved", "Declined"].includes(req.query.status) ? req.query.status : undefined;
  const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
  const bookingId = typeof req.query.bookingId === "string" ? req.query.bookingId : undefined;
  const rows = await prisma.cancellationRequest.findMany({
    where: { accountId: account.id, ...(status ? { status } : {}), ...(bookingId ? { bookingId } : {}), ...(leadId ? { booking: { leadId } } : {}) },
    include: ADMIN_REQUEST_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ requests: rows.map((r) => serializeRequest(r, settings)) });
});

for (const decision of ["approve", "decline"] as const) {
  cancellationRequestsRouter.post(`/:id/${decision}`, async (req, res) => {
    const account = await getDefaultAccount();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    try {
      const done = await decideCancellation(String(req.params.id), account.id, decision, note);
      const settings = await getSettings(account.id);
      const row = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: done.id }, include: ADMIN_REQUEST_INCLUDE });
      res.json({ ...done, request: serializeRequest(row, settings) });
    } catch (err) {
      fail(res, err);
    }
  });
}

// ---- Overview: /api/money/overview -------------------------------------------------

export const moneyRouter = Router();

const MONEY_IN_DAYS = 7;
const BALANCE_SOON_DAYS = 14;
const LIVE = ["Held", "Contract Sent", "Signed"];

moneyRouter.get("/overview", async (_req, res) => {
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  const now = new Date();
  const todayText = todayEastern(now);
  const since = new Date(now.getTime() - MONEY_IN_DAYS * 86_400_000);

  const paid = await prisma.payment.findMany({
    where: { accountId: account.id, status: { in: ["succeeded", "refunded", "disputed"] }, paidAt: { gte: since } },
    orderBy: { paidAt: "desc" },
    select: { id: true, kind: true, method: true, amountCents: true, refundedCents: true, paidAt: true, booking: { select: { id: true, customerName: true, eventDate: true } } },
    take: 200,
  });
  const moneyIn = paid.map((p) => ({ id: p.id, bookingId: p.booking.id, customerName: p.booking.customerName, eventDate: p.booking.eventDate.toISOString().slice(0, 10), kind: p.kind, method: p.method, amountCents: p.amountCents, paidAt: (p.paidAt as Date).toISOString() }));

  const live = await prisma.booking.findMany({
    where: { accountId: account.id, status: { in: LIVE }, eventDate: { gte: new Date(`${todayText}T00:00:00Z`) }, total: { not: null }, OR: [{ retainerPaid: false }, { balancePaid: false }] },
    include: { agreement: { select: { contractStatus: true, contractDocument: { select: { documentJson: true } } } }, payments: true },
    orderBy: { eventDate: "asc" },
    take: 500,
  });
  const retainers: unknown[] = [];
  const balances: unknown[] = [];
  const soon = addDays(todayText, BALANCE_SOON_DAYS);
  for (const b of live) {
    const money = amountsFor(b, b.payments, settings);
    const owed = owedStep(b, money);
    const row = { bookingId: b.id, customerName: b.customerName, eventDate: b.eventDate.toISOString().slice(0, 10), status: displayStatus(b) };
    if ((owed.step === "retainer" || owed.step === "sign") && owed.amountCents) {
      retainers.push({ ...row, amountCents: owed.amountCents, needsSignature: owed.step === "sign", requestedAt: b.retainerRequestedAt?.toISOString() ?? null, payLinkSentAt: b.payLinkSentAt?.toISOString() ?? null });
    } else if (owed.step === "balance" && owed.amountCents) {
      const dueDate = daysBefore(row.eventDate, settings.balanceDueDays);
      if (dueDate <= soon) balances.push({ ...row, amountCents: owed.amountCents, dueDate, overdue: dueDate < todayText });
    }
  }
  res.json({ moneyIn: { days: MONEY_IN_DAYS, totalCents: moneyIn.reduce((s, p) => s + p.amountCents, 0), payments: moneyIn }, waiting: { balanceDays: BALANCE_SOON_DAYS, retainers, balances } });
});
