import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const router = Router();
const text = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

// n8n reporting what happened to a message it sent (or one it sent on its
// own, like a campaign text). Mounted behind the shared secret. Stored in
// the same log as our own sends, so admin has one place to see it.
//
//   { channel: "sms" | "email",
//     recipient: string,
//     success: boolean,
//     referenceId?: string,   // the referenceId we sent n8n, if this answers one
//     detail?: string,        // a status or error message
//     providerId?: string,    // e.g. the Twilio SID or mail id
//     occurredAt?: ISO string }
//
// If referenceId matches a row we logged, that row gets the confirmation.
// Otherwise a new row is recorded as an n8n send.
router.post("/send-status", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.channel !== "sms" && b.channel !== "email") return res.status(400).json({ error: 'channel must be "sms" or "email"' });
  const recipient = text(b.recipient, 200);
  if (!recipient) return res.status(400).json({ error: "recipient is required" });
  if (typeof b.success !== "boolean") return res.status(400).json({ error: "success must be true or false" });
  const referenceId = b.referenceId === undefined || b.referenceId === null ? null : text(b.referenceId, 100);
  if (b.referenceId !== undefined && b.referenceId !== null && !referenceId) return res.status(400).json({ error: "referenceId must be text" });
  let occurredAt = new Date();
  if (b.occurredAt !== undefined) {
    occurredAt = new Date(String(b.occurredAt));
    if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ error: "occurredAt must be a date-time" });
  }
  const detail = text(b.detail);
  const providerId = text(b.providerId, 200);
  const confirmation = b.success ? "delivered" : "failed";
  const account = await getDefaultAccount();

  const existing = referenceId ? await prisma.messageLog.findFirst({ where: { id: referenceId, accountId: account.id } }) : null;
  if (existing) {
    const updated = await prisma.messageLog.update({
      where: { id: existing.id },
      data: { confirmation, confirmationAt: occurredAt, confirmationDetail: detail, ...(providerId && !existing.providerRef ? { providerRef: providerId } : {}) },
    });
    return res.json({ ok: true, matched: true, logId: updated.id, confirmation });
  }

  const created = await prisma.messageLog.create({
    data: {
      accountId: account.id,
      channel: b.channel,
      source: "n8n",
      purpose: "n8n-external",
      recipient,
      body: detail ?? "(sent by n8n)",
      status: b.success ? "sent" : "failed",
      error: b.success ? null : detail,
      providerRef: providerId,
      confirmation,
      confirmationAt: occurredAt,
      confirmationDetail: detail,
    },
  });
  res.status(201).json({ ok: true, matched: false, logId: created.id, confirmation });
});

export default router;
