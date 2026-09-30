import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { sendSms } from "../messaging.js";
import { sendContractLinkSms } from "../notify.js";

const router = Router();
const MAX_BODY = 1000;

// The send log, newest first: every text and email the system tried to
// send, whether it went, and what n8n later confirmed. ?channel=sms|email
// and ?status= narrow it.
router.get("/", async (req, res) => {
  const channel = req.query.channel === "sms" || req.query.channel === "email" ? req.query.channel : undefined;
  const status = typeof req.query.status === "string" && req.query.status !== "" ? req.query.status : undefined;
  const bookingId = typeof req.query.bookingId === "string" && req.query.bookingId !== "" ? req.query.bookingId : undefined;
  const crewMemberId = typeof req.query.crewMemberId === "string" && req.query.crewMemberId !== "" ? req.query.crewMemberId : undefined;
  const leadId = typeof req.query.leadId === "string" && req.query.leadId !== "" ? req.query.leadId : undefined;
  const gigId = typeof req.query.gigId === "string" && req.query.gigId !== "" ? req.query.gigId : undefined;
  const journey = req.query.journey === "lead" || req.query.journey === "client" || req.query.journey === "crew" ? req.query.journey : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
  const account = await getDefaultAccount();
  const rows = await prisma.messageLog.findMany({
    where: { accountId: account.id, ...(bookingId ? { bookingId } : {}), ...(crewMemberId ? { crewMemberId } : {}), ...(leadId ? { leadId } : {}), ...(gigId ? { gigId } : {}), ...(journey ? { journey } : {}), ...(channel ? { channel } : {}), ...(status ? { status: status.endsWith("*") ? { startsWith: status.slice(0, -1) } : status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(rows);
});

// Counts for the Overview card: the last 7 days by channel, split into
// what went, what didn't, what was skipped, and what n8n confirmed.
router.get("/summary", async (_req, res) => {
  const account = await getDefaultAccount();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.messageLog.findMany({ where: { accountId: account.id, createdAt: { gte: since } }, select: { channel: true, status: true, confirmation: true } });
  const zero = () => ({ total: 0, sent: 0, failed: 0, skipped: 0, delivered: 0 });
  const out = { sms: zero(), email: zero() };
  for (const r of rows) {
    const b = r.channel === "email" ? out.email : out.sms;
    b.total += 1;
    if (r.status === "sent") b.sent += 1;
    else if (r.status.startsWith("skipped")) b.skipped += 1;
    else if (r.status === "failed") b.failed += 1;
    if (r.confirmation === "delivered") b.delivered += 1;
  }
  const last = await prisma.messageLog.findFirst({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  res.json({ days: 7, ...out, lastAt: last?.createdAt ?? null });
});

// Staff sending by hand, whatever the automation is doing. target is one of
// bookingId, designRequestId, leadId (its customer) or crewMemberId.
// kind "contract-link" texts the signing link (customers only); kind
// "custom" texts exactly what staff typed. The result is the log row.
router.post("/send", async (req, res) => {
  const { target, kind, body } = req.body ?? {};
  if (!target || typeof target !== "object") return res.status(400).json({ error: "target is required" });
  if (kind !== "contract-link" && kind !== "custom") return res.status(400).json({ error: 'kind must be "contract-link" or "custom"' });
  const account = await getDefaultAccount();
  const t = target as Record<string, unknown>;

  let text = "";
  if (kind === "custom") {
    text = typeof body === "string" ? body.trim() : "";
    if (text === "" || text.length > MAX_BODY) return res.status(400).json({ error: `body is required, up to ${MAX_BODY} characters` });
  }

  if (typeof t.crewMemberId === "string") {
    if (kind === "contract-link") return res.status(400).json({ error: "Crew members don't have a contract to sign." });
    const crew = await prisma.crewMember.findFirst({ where: { id: t.crewMemberId, accountId: account.id }, select: { id: true, phone: true } });
    if (!crew) return res.status(404).json({ error: "crew member not found" });
    const result = await sendSms({ to: crew.phone, body: text, purpose: "manual-message", link: { crewMemberId: crew.id }, meta: { triggerKey: "manual_message", journey: "crew" } });
    return res.json(await prisma.messageLog.findUnique({ where: { id: result.logId } }));
  }

  let bookingId: string | undefined;
  let designRequestId: string | undefined;
  let phone: string | null = null;
  if (typeof t.bookingId === "string") {
    const b = await prisma.booking.findFirst({ where: { id: t.bookingId, accountId: account.id }, select: { id: true, phone: true } });
    if (!b) return res.status(404).json({ error: "booking not found" });
    bookingId = b.id;
    phone = b.phone;
  } else if (typeof t.designRequestId === "string") {
    const r = await prisma.designRequest.findFirst({ where: { id: t.designRequestId, accountId: account.id }, select: { id: true, phone: true } });
    if (!r) return res.status(404).json({ error: "design request not found" });
    designRequestId = r.id;
    phone = r.phone;
  } else if (typeof t.leadId === "string") {
    // A lead texts its customer: the newest booking it made, whose phone
    // is a real number; failing that the lead's own contact if it is one.
    const lead = await prisma.lead.findFirst({
      where: { id: t.leadId, accountId: account.id },
      select: { contact: true, bookings: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, phone: true } } },
    });
    if (!lead) return res.status(404).json({ error: "lead not found" });
    bookingId = lead.bookings[0]?.id;
    phone = lead.bookings[0]?.phone ?? lead.contact;
    if (kind === "contract-link" && !bookingId) return res.status(400).json({ error: "This lead has no booking yet, so there is no contract to send." });
  } else {
    return res.status(400).json({ error: "target needs one of bookingId, designRequestId, leadId, crewMemberId" });
  }

  const result =
    kind === "contract-link"
      ? await sendContractLinkSms(bookingId ? { bookingId } : { designRequestId: designRequestId as string }, "manual-contract-link")
      : await sendSms({ to: phone, body: text, purpose: "manual-message", link: { bookingId, designRequestId }, meta: { triggerKey: "manual_message", journey: t.leadId && !bookingId ? "lead" : "client", leadId: typeof t.leadId === "string" ? t.leadId : null } });
  if (!result) return res.status(500).json({ error: "The message could not be prepared." });
  res.json(await prisma.messageLog.findUnique({ where: { id: result.logId } }));
});

export default router;
