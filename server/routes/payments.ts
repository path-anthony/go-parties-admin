import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { requireOwner } from "../auth.js";
import { prisma } from "../db.js";
import { INVALID } from "../validate.js";
import { updateDelivery } from "../delivery.js";
import { MANUAL_METHODS, PAYMENT_KINDS, PaymentError, loadMoney, paymentStatus, recordManualPayment, refundPayment, type PaymentKind } from "../payments.js";
import { StripeError, stripeConfigured, stripeMode } from "../stripe/client.js";
import { audit } from "../users.js";

// Block T1. Payments: the public status check the storefront polls, and the
// admin's Payments section on a booking (list, totals, record by hand,
// owner-only refund) plus the delivery correction.

function fail(res: import("express").Response, err: unknown) {
  if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message, reason: err.reason });
  if (err instanceof StripeError) return res.status(err.status >= 500 ? 502 : 409, ).json({ error: err.message, reason: "stripe" });
  throw err;
}

// ---- public ----------------------------------------------------------------------

export const publicPaymentsRouter = Router();

// GET /api/payments/status?sessionId=cs_...
publicPaymentsRouter.get("/status", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
  if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return res.status(400).json({ error: "sessionId is required" });
  const view = await paymentStatus(sessionId);
  if (!view) return res.status(404).json({ error: "That payment session isn't known." });
  res.setHeader("Cache-Control", "no-store");
  res.json(view);
});

// ---- admin -----------------------------------------------------------------------

export const adminPaymentsRouter = Router();

function serializePayment(p: { id: string; kind: string; amountCents: number; currency: string; method: string; status: string; refundedCents: number; failureReason: string | null; note: string | null; recordedByName: string | null; paidAt: Date | null; createdAt: Date; stripePaymentIntentId: string | null }) {
  return {
    id: p.id,
    kind: p.kind,
    amountCents: p.amountCents,
    currency: p.currency,
    method: p.method,
    status: p.status,
    refundedCents: p.refundedCents,
    failureReason: p.failureReason,
    note: p.note,
    recordedByName: p.recordedByName,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    refundable: p.method === "card" && !!p.stripePaymentIntentId && (p.status === "succeeded" || p.status === "refunded") && p.refundedCents < p.amountCents,
  };
}

async function paymentsView(bookingId: string) {
  const { booking, money } = await loadMoney(bookingId);
  return {
    stripeConfigured: stripeConfigured(),
    stripeMode: stripeMode(),
    money,
    disputeFlaggedAt: booking.disputeFlaggedAt?.toISOString() ?? null,
    disputeNote: booking.disputeNote,
    payments: booking.payments.map(serializePayment),
  };
}

async function own(id: string) {
  const account = await getDefaultAccount();
  return prisma.booking.findFirst({ where: { id, accountId: account.id }, select: { id: true } });
}

adminPaymentsRouter.get("/:id/payments", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  try {
    res.json(await paymentsView(b.id));
  } catch (err) {
    fail(res, err);
  }
});

// Cash or check taken outside Stripe.
adminPaymentsRouter.post("/:id/payments", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  if (!(PAYMENT_KINDS as readonly unknown[]).includes(kind)) return res.status(400).json({ error: `kind must be one of ${PAYMENT_KINDS.join(", ")}` });
  const method = body.method;
  if (!(MANUAL_METHODS as readonly unknown[]).includes(method)) return res.status(400).json({ error: `method must be one of ${MANUAL_METHODS.join(", ")}` });
  const amountCents = body.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) return res.status(400).json({ error: "amountCents must be a whole number of cents above 0" });
  const note = body.note === undefined || body.note === null ? null : typeof body.note === "string" ? body.note.trim().slice(0, 300) || null : INVALID;
  if (note === INVALID) return res.status(400).json({ error: "note must be text" });
  try {
    await recordManualPayment(b.id, { kind: kind as PaymentKind, amountCents, method: method as string, note });
    res.status(201).json(await paymentsView(b.id));
  } catch (err) {
    fail(res, err);
  }
});

// Owners only: a partial or full refund of a card payment through Stripe.
adminPaymentsRouter.post("/:id/payments/:paymentId/refund", requireOwner, async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const amountCents = body.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: "amountCents must be a whole number of cents above 0" });
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  const p = await prisma.payment.findFirst({ where: { id: String(req.params.paymentId), bookingId: b.id }, select: { id: true } });
  if (!p) return res.status(404).json({ error: "payment not found" });
  try {
    await refundPayment(p.id, amountCents, note);
    await audit("payment refunded", `booking ${b.id}, $${(amountCents / 100).toFixed(2)}`);
    res.json(await paymentsView(b.id));
  } catch (err) {
    fail(res, err);
  }
});

// The delivery location: staff correct the address or the pin, or mark it
// checked. Who did it is recorded.
adminPaymentsRouter.patch("/:id/delivery", async (req, res) => {
  const b = await own(String(req.params.id));
  if (!b) return res.status(404).json({ error: "booking not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof updateDelivery>[1] = {};
  if ("address" in body) {
    if (body.address !== null && (typeof body.address !== "string" || body.address.length > 300)) return res.status(400).json({ error: "address must be text up to 300 characters, or null" });
    patch.address = body.address === null ? null : (body.address as string).trim() || null;
  }
  for (const k of ["setupLat", "setupLng"] as const) {
    if (k in body) {
      const v = body[k];
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > (k === "setupLat" ? 90 : 180))) return res.status(400).json({ error: `${k} must be a coordinate, or null` });
      patch[k] = v as number | null;
    }
  }
  if ("setupNotes" in body) {
    if (body.setupNotes !== null && (typeof body.setupNotes !== "string" || body.setupNotes.length > 500)) return res.status(400).json({ error: "setupNotes must be text up to 500 characters, or null" });
    patch.setupNotes = body.setupNotes === null ? null : (body.setupNotes as string).trim() || null;
  }
  if ("verified" in body) {
    if (typeof body.verified !== "boolean") return res.status(400).json({ error: "verified must be true or false" });
    patch.verified = body.verified;
  }
  const updated = await updateDelivery(b.id, patch);
  if (updated === INVALID) return res.status(400).json({ error: "no editable fields provided" });
  res.json({ ok: true, addressCheck: updated.addressCheck, addressCheckReason: updated.addressCheckReason, addressCheckedAt: updated.addressCheckedAt?.toISOString() ?? null, addressCheckedByName: updated.addressCheckedByName, address: updated.address, setupLat: updated.setupLat, setupLng: updated.setupLng, setupNotes: updated.setupNotes });
});
