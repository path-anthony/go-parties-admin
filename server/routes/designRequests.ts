import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { actorFields } from "../actor.js";
import { prisma } from "../db.js";
import { bookingMapsUrl } from "../delivery.js";
import { clearRequestAlerts } from "../notifications.js";
import { safeText } from "../sanitize.js";
import { sendTemplatedMessage } from "../sendTemplated.js";
import { audit } from "../users.js";
import { normalizeText } from "../validate.js";

const STATUSES = ["Open", "Converted", "Dismissed"] as const;
const MAX_NOTES = 2000;
const MAX_REASON = 300;

import { LeadActionError, markLost, reopenLead } from "../inboxLoad.js";
import { isLostStage } from "../../src/lib/leadStages.js";
const router = Router();

function serialize<T extends { total: unknown; placeId: string | null; addressLat: number | null; addressLng: number | null; setupLat: number | null; setupLng: number | null }>(request: T) {
  return { ...request, total: request.total === null ? null : Number(request.total), mapsUrl: bookingMapsUrl(request) };
}

// The review queue. Newest first; ?status=Open (or Converted, Dismissed)
// narrows it. Turning a request into a booking is not here: staff do that
// in New booking, which is given the request's id, so the same locks and
// the agreement rule apply. This reads, takes notes and dismisses.
router.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  }
  const account = await getDefaultAccount();
  const requests = await prisma.designRequest.findMany({
    where: { accountId: account.id, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests.map(serialize));
});

// Block F3a: one request, for the lead popup.
router.get("/:id", async (req, res) => {
  const account = await getDefaultAccount();
  const request = await prisma.designRequest.findFirst({ where: { id: String(req.params.id), accountId: account.id } });
  if (!request) return res.status(404).json({ error: "design request not found" });
  res.json(serialize(request));
});

router.patch("/:id", async (req, res) => {
  const body = req.body ?? {};
  const account = await getDefaultAccount();
  const existing = await prisma.designRequest.findFirst({ where: { id: String(req.params.id), accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "design request not found" });

  const data: { notes?: string | null; status?: string; dismissReason?: string | null; dismissedAt?: Date | null; dismissedByName?: string | null } = {};
  if ("notes" in body) {
    const notes = body.notes === null ? null : typeof body.notes === "string" ? normalizeText(body.notes) : undefined;
    if (notes === undefined || (notes !== null && notes.length > MAX_NOTES)) {
      return res.status(400).json({ error: `notes must be text up to ${MAX_NOTES} characters` });
    }
    data.notes = notes;
  }
  let dismissing = false;
  if ("status" in body) {
    // Converted is only ever set by making the booking; the only manual
    // moves are to Dismissed and back to Open.
    if (body.status !== "Dismissed" && body.status !== "Open") {
      return res.status(400).json({ error: "status can be set to Dismissed or Open. Converted happens when the booking is made." });
    }
    if (existing.status === "Converted") {
      return res.status(409).json({ error: "This request already became a booking." });
    }
    data.status = body.status;
    if (body.status === "Dismissed" && existing.status !== "Dismissed") {
      // Block F2: a dismissal says why, in a line staff can read back later.
      const reason = typeof body.reason === "string" ? safeText(body.reason, MAX_REASON) : "";
      if (!reason) return res.status(400).json({ error: "Say why this request is being dismissed.", reason: "reason-required" });
      if (body.tellCustomer !== undefined && typeof body.tellCustomer !== "boolean") return res.status(400).json({ error: "tellCustomer must be true or false" });
      dismissing = true;
      data.dismissReason = reason;
      data.dismissedAt = new Date();
      data.dismissedByName = actorFields().userName ?? "staff";
    }
    if (body.status === "Open") {
      data.dismissReason = null;
      data.dismissedAt = null;
      data.dismissedByName = null;
    }
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "no editable fields provided" });

  let updated = await prisma.designRequest.update({ where: { id: existing.id }, data });
  // Block F3b: the request's lead follows it. Dismissed closes the lead as
  // Lost (the reason stays with staff); reopened brings it back. Neither can
  // stop the request itself from saving.
  if (existing.leadId && data.status && data.status !== existing.status) {
    try {
      const lead = await prisma.lead.findFirst({ where: { id: existing.leadId, accountId: account.id }, select: { id: true, status: true, bookings: { select: { status: true } } } });
      const live = lead?.bookings.some((b) => b.status !== "Cancelled" && b.status !== "Released") ?? false;
      if (lead && data.status === "Dismissed" && !live && !isLostStage(lead.status)) await markLost(account.id, lead.id, "Other", `Storefront request dismissed: ${data.dismissReason}`);
      else if (lead && data.status === "Open" && isLostStage(lead.status)) await reopenLead(account.id, lead.id);
      else if (lead) await prisma.leadActivity.create({ data: { leadId: lead.id, kind: "status", text: data.status === "Dismissed" ? `Storefront request dismissed: ${data.dismissReason}` : "Storefront request reopened.", ...actorFields() } });
    } catch (err) {
      if (!(err instanceof LeadActionError)) throw err;
      await prisma.leadActivity.create({ data: { leadId: existing.leadId, kind: "status", text: data.status === "Dismissed" ? `Storefront request dismissed: ${data.dismissReason}` : "Storefront request reopened.", ...actorFields() } });
    }
  }
  // What happened to the "Tell the customer" email, when it was asked for.
  let customerTold: { sent: boolean; why: string | null } | null = null;
  if (dismissing) {
    await clearRequestAlerts(existing.id);
    await audit("design request dismissed", `${existing.customerName}: ${data.dismissReason}`);
    if (body.tellCustomer === true) {
      if (!existing.email) customerTold = { sent: false, why: "There is no email address on this request." };
      else {
        try {
          // Email only: the wording is the "Request closed" template in Messages, Templates.
          const outcomes = await sendTemplatedMessage("design_request_closed", { designRequestId: existing.id }, { email: existing.email }, `design_request_closed:${existing.id}:${data.dismissedAt?.getTime()}`, { purpose: "design-request-closed", channels: ["email"] });
          const sent = outcomes.some((o) => o.status === "sent");
          customerTold = { sent, why: sent ? null : (outcomes[0]?.status === "skipped_disabled" ? "The Request closed email is switched off in Messages, Templates." : (outcomes[0]?.error ?? outcomes[0]?.status ?? "The email could not be sent.")) };
          if (sent) updated = await prisma.designRequest.update({ where: { id: existing.id }, data: { customerToldAt: new Date() } });
        } catch {
          customerTold = { sent: false, why: "The email could not be sent." };
        }
      }
    }
  }
  res.json({ ...serialize(updated), ...(customerTold ? { customerTold } : {}) });
});

export default router;
