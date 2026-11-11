import { actorFields } from "./actor.js";
import { daysBefore } from "./contract/goMoney.js";
import { prisma } from "./db.js";
import { CONTACT_KINDS, LOST_REASONS, buildInbox, contactParts, matchLead, newStageOf, stageNamed, type ContactKind, type InboxLead, type InboxRequest, type LeadMatch } from "./inbox.js";
import { safeErr } from "./log.js";
import { owedStep } from "./payLink.js";
import { amountsFor } from "./payments.js";
import { safeText } from "./sanitize.js";
import { sendTemplatedMessage } from "./sendTemplated.js";
import { getSettings } from "./settings.js";
import { buildToday, type TodayBooking } from "./today.js";
import { todayEastern } from "./validate.js";
import { isWeddingBooking } from "./weddingDetails/logic.js";
import { isLostStage, isWonStage, LOST_STAGE, WON_STAGE } from "../src/lib/leadStages.js";

// Block F3a. Reads the database for the Leads inbox and the Today view, and
// carries out the three things staff do to a lead: contact, how they buy,
// close. The rules are in server/inbox.ts and server/today.ts (pure).

const LEAD_INCLUDE = {
  bookings: {
    select: {
      id: true,
      status: true,
      eventDate: true,
      tier: true,
      retainerPaid: true,
      total: true,
      createdAt: true,
      agreement: { select: { contractStatus: true } },
      designRequest: { select: { id: true } },
      cancellationRequests: { where: { status: "Open" }, select: { id: true, status: true, createdAt: true } },
      units: { select: { unit: { select: { item: { select: { name: true } } } } } },
      gigs: { select: { itemName: true } },
      package: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

type LeadRow = Awaited<ReturnType<typeof loadLeadRows>>[number];
function loadLeadRows(accountId: string) {
  return prisma.lead.findMany({ where: { accountId }, include: LEAD_INCLUDE, orderBy: { createdAt: "desc" } });
}

const toInboxLead = (l: LeadRow): InboxLead => ({
  ...l,
  bookings: l.bookings.map((b) => ({ ...b, itemNames: [...b.units.map((u) => u.unit.item.name), ...b.gigs.map((g) => g.itemName)], packageName: b.package?.name ?? null })),
});

export async function columnNames(accountId: string): Promise<string[]> {
  return (await prisma.leadStatus.findMany({ where: { accountId }, orderBy: { position: "asc" }, select: { name: true } })).map((s) => s.name);
}

export async function loadInbox(accountId: string, now = new Date()) {
  const [leads, requests, columns] = await Promise.all([
    loadLeadRows(accountId),
    prisma.designRequest.findMany({ where: { accountId, status: { in: ["Open", "Dismissed"] } }, orderBy: { createdAt: "desc" } }),
    columnNames(accountId),
  ]);
  const today = todayEastern(now);
  const built = buildInbox(leads.map(toInboxLead), requests as InboxRequest[], columns, today);
  return { ...built, today, columns };
}

const LIVE = ["Held", "Contract Sent", "Signed"];
const MONEY_IN_DAYS = 7;

// Payments received in the last 7 days, newest first, with a total.
export async function loadMoneyIn(accountId: string, now = new Date()) {
  const since = new Date(now.getTime() - MONEY_IN_DAYS * 86_400_000);
  const paid = await prisma.payment.findMany({
    where: { accountId, status: { in: ["succeeded", "refunded", "disputed"] }, paidAt: { gte: since } },
    orderBy: { paidAt: "desc" },
    select: { id: true, kind: true, method: true, amountCents: true, paidAt: true, booking: { select: { id: true, customerName: true, eventDate: true } } },
    take: 200,
  });
  const payments = paid.map((p) => ({ id: p.id, bookingId: p.booking.id, customerName: p.booking.customerName, eventDate: p.booking.eventDate.toISOString().slice(0, 10), kind: p.kind, method: p.method, amountCents: p.amountCents, paidAt: (p.paidAt as Date).toISOString() }));
  return { days: MONEY_IN_DAYS, totalCents: payments.reduce((s, p) => s + p.amountCents, 0), payments };
}

// Every booking that is going ahead, with what is still open on it.
export async function loadTodayBookings(accountId: string, now = new Date()): Promise<TodayBooking[]> {
  const settings = await getSettings(accountId);
  const today = todayEastern(now);
  const rows = await prisma.booking.findMany({
    where: { accountId, status: { in: LIVE }, eventDate: { gte: new Date(`${today}T00:00:00Z`) } },
    include: { agreement: { select: { contractStatus: true, contractSentAt: true, contractDocument: { select: { documentJson: true } } } }, payments: true, package: { select: { occasions: true } }, weddingDetails: { select: { status: true } } },
    orderBy: { eventDate: "asc" },
    take: 1000,
  });
  return rows.map((b) => {
    const money = amountsFor(b, b.payments, settings);
    const owed = owedStep(b, money);
    const eventDate = b.eventDate.toISOString().slice(0, 10);
    const retainerOwed = owed.step === "retainer" || owed.step === "sign" ? owed.amountCents : null;
    return {
      id: b.id,
      leadId: b.leadId,
      customerName: b.customerName,
      eventDate,
      eventTime: b.eventTime,
      stage: b.status,
      needsSignature: owed.step === "sign" || (b.tier === 2 && b.agreement?.contractStatus !== "Signed"),
      contractSentAt: b.agreement?.contractSentAt?.toISOString() ?? null,
      retainerOwedCents: retainerOwed,
      payLinkSentAt: b.payLinkSentAt?.toISOString() ?? null,
      balanceOwedCents: owed.step === "balance" ? owed.amountCents : null,
      balanceDueDate: owed.step === "balance" ? daysBefore(eventDate, settings.balanceDueDays) : null,
      weddingDetailsMissing: isWeddingBooking({ weddingOverride: b.weddingOverride, occasion: b.occasion, package: b.package }) && b.weddingDetails?.status !== "submitted",
    };
  });
}

export async function loadToday(accountId: string, now = new Date()) {
  const [inbox, bookings, moneyIn] = await Promise.all([loadInbox(accountId, now), loadTodayBookings(accountId, now), loadMoneyIn(accountId, now)]);
  return { today: inbox.today, moneyIn, columns: buildToday(inbox.rows, bookings, inbox.today) };
}

// ---- linking a booking to its lead ------------------------------------------------

// The open leads a new booking could belong to (see matchLead for the rule).
export async function findLeadMatch(accountId: string, who: { name: string | null; email: string | null; phone: string | null }, now = new Date()): Promise<LeadMatch> {
  const leads = await prisma.lead.findMany({
    where: { accountId },
    select: { id: true, status: true, customerName: true, contact: true, createdAt: true, bookings: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  return matchLead(leads, who, now);
}

// ---- the three actions --------------------------------------------------------------

export class LeadActionError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function ownLead(accountId: string, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, accountId } });
  if (!lead) throw new LeadActionError(404, "not-found", "lead not found");
  return lead;
}

const KIND_WORD: Record<ContactKind, string> = { call: "Called", text: "Texted", email: "Emailed" };

// What a first contact does to the lead's column: New becomes Contacted, when
// a column by that name exists. Any other column is left where staff put it.
async function contactedStatus(accountId: string, current: string): Promise<string | null> {
  const columns = await columnNames(accountId);
  const contacted = stageNamed(columns, "Contacted");
  return contacted && current === newStageOf(columns) && contacted !== current ? contacted : null;
}

// 1. Contact: staff called, texted or emailed, with a note.
export async function logContact(accountId: string, leadId: string, kind: ContactKind, note: string | null, now = new Date()) {
  if (!(CONTACT_KINDS as readonly string[]).includes(kind)) throw new LeadActionError(400, "kind-invalid", `kind must be one of ${CONTACT_KINDS.join(", ")}`);
  const lead = await ownLead(accountId, leadId);
  const moveTo = lead.firstContactedAt === null ? await contactedStatus(accountId, lead.status) : null;
  const text = `${KIND_WORD[kind]} the customer${note ? `: ${note}` : "."}`;
  await prisma.$transaction([
    prisma.leadActivity.create({ data: { leadId, kind, text, ...actorFields() } }),
    prisma.lead.update({ where: { id: leadId }, data: { firstContactedAt: lead.firstContactedAt ?? now, lastContactedAt: now, ...(moveTo ? { status: moveTo, sortOrder: 0 } : {}) } }),
    ...(moveTo ? [prisma.leadActivity.create({ data: { leadId, kind: "status", text: `Moved to ${moveTo} on first contact.`, ...actorFields() } })] : []),
  ]);
  return { movedTo: moveTo };
}

// 2a. How they buy: send the link to the store, by text and email.
export async function sendStoreLink(accountId: string, leadId: string, now = new Date()) {
  const lead = await ownLead(accountId, leadId);
  const parts = contactParts(lead.contact);
  if (!parts.phone && !parts.email) throw new LeadActionError(409, "no-contact", "There is no phone number or email address on this lead, so the link cannot be sent. Add one to the contact line first.");
  const store = process.env.STOREFRONT_URL?.replace(/\/$/, "");
  if (!store) throw new LeadActionError(409, "no-store", "The store address is not set up (STOREFRONT_URL), so there is no link to send.");
  const outcomes = await sendTemplatedMessage("lead_store_link", { leadId, extra: { storeLink: store } }, { ...(parts.phone ? { phone: parts.phone } : {}), ...(parts.email ? { email: parts.email } : {}) }, `lead_store_link:${leadId}:${now.getTime()}`, { purpose: "store-link" });
  const sent = outcomes.filter((o) => o.status === "sent").map((o) => (o.channel === "sms" ? "text" : "email"));
  if (sent.length === 0) {
    const o = outcomes.find((x) => x.status !== "skipped_disabled") ?? outcomes[0];
    throw new LeadActionError(409, "not-sent", `The store link did not go: ${o ? (o.status === "skipped_disabled" ? "the Store link message is switched off in Messages, Templates" : (o.error ?? o.status)) : "nothing to send it to"}.`);
  }
  const moveTo = lead.firstContactedAt === null ? await contactedStatus(accountId, lead.status) : null;
  await prisma.$transaction([
    prisma.leadActivity.create({ data: { leadId, kind: sent.includes("text") ? "text" : "email", text: `Sent the store link by ${sent.join(" and ")}.`, ...actorFields() } }),
    prisma.lead.update({ where: { id: leadId }, data: { storeLinkSentAt: now, firstContactedAt: lead.firstContactedAt ?? now, lastContactedAt: now, ...(moveTo ? { status: moveTo, sortOrder: 0 } : {}) } }),
  ]);
  return { sent, movedTo: moveTo };
}

// 2c. Not ready: a date to come back to them and a note. A null date clears it.
export async function setFollowUp(accountId: string, leadId: string, date: Date | null, note: string | null) {
  await ownLead(accountId, leadId);
  const day = date ? date.toISOString().slice(0, 10) : null;
  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { followUpOn: date, followUpNote: date ? note : null } }),
    prisma.leadActivity.create({ data: { leadId, kind: "status", text: day ? `Not ready yet. Follow up on ${day}${note ? `: ${note}` : "."}` : "Follow up date cleared.", ...actorFields() } }),
  ]);
}

// 3. Close: Lost, with a reason from the list and an optional note.
export async function markLost(accountId: string, leadId: string, reason: string, note: string | null, now = new Date()) {
  if (!(LOST_REASONS as readonly string[]).includes(reason)) throw new LeadActionError(400, "reason-required", `Pick a reason: ${LOST_REASONS.join(", ")}.`);
  const lead = await ownLead(accountId, leadId);
  const lost = stageNamed(await columnNames(accountId), LOST_STAGE);
  if (!lost) throw new LeadActionError(409, "no-lost-column", `There is no lead column named "${LOST_STAGE}". Add one in Settings, Messages and notifications, Lead columns, then mark this lead Lost.`);
  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status: lost, sortOrder: 0, lostReason: reason, lostNote: note, lostAt: now, followUpOn: null, followUpNote: null } }),
    prisma.leadActivity.create({ data: { leadId, kind: "status", text: `Marked Lost: ${reason}${note ? `. ${note}` : "."}`, ...actorFields() } }),
  ]);
  return { status: lost, was: lead.status };
}

// Undo a Lost: back to Contacted (or the first column), reason cleared.
export async function reopenLead(accountId: string, leadId: string) {
  const lead = await ownLead(accountId, leadId);
  if (!isLostStage(lead.status)) throw new LeadActionError(409, "not-lost", "This lead is not marked Lost.");
  const columns = await columnNames(accountId);
  const to = (lead.firstContactedAt ? stageNamed(columns, "Contacted") : null) ?? newStageOf(columns);
  if (!to) throw new LeadActionError(409, "no-columns", "There are no lead columns.");
  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status: to, sortOrder: 0, lostReason: null, lostNote: null, lostAt: null } }),
    prisma.leadActivity.create({ data: { leadId, kind: "status", text: `Reopened. Moved to ${to}.`, ...actorFields() } }),
  ]);
  return { status: to };
}

// A booking was just made for this lead (staff built it from the lead, or a
// storefront booking matched it): the lead moves to Booked. Never throws.
export async function markLeadBooked(leadId: string, how: string): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { accountId: true, status: true } });
    if (!lead) return;
    const booked = stageNamed(await columnNames(lead.accountId), WON_STAGE);
    await prisma.$transaction([
      prisma.lead.update({ where: { id: leadId }, data: { ...(booked && !isWonStage(lead.status) ? { status: booked, sortOrder: 0 } : {}), followUpOn: null, followUpNote: null, lostReason: null, lostNote: null, lostAt: null } }),
      prisma.leadActivity.create({ data: { leadId, kind: "status", text: `${how}${booked && !isWonStage(lead.status) ? ` Moved to ${booked}.` : ""}`, ...actorFields() } }),
    ]);
  } catch (err) {
    console.warn("[leads] could not mark the lead booked:", safeErr(err));
  }
}

export const cleanNote = (value: unknown, max = 1000): string | null => (typeof value === "string" && value.trim() !== "" ? safeText(value.trim(), max) || null : null);
