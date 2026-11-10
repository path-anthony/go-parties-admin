import type { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../db.js";
import { safeErr } from "../log.js";
import { bookingLink, createNotifications, type NotificationInput } from "../notifications.js";
import { safeText } from "../sanitize.js";
import { audit } from "../users.js";
import { automaticWedding, cleanAnswers, dayLabel, dueDateFor, isWeddingBooking, mergeAnswers, prefillFor, sectionProgress, shownSections, type Answers, type WeddingStatus } from "./logic.js";
import { CURRENT_TEMPLATE_VERSION, templateFor } from "./template.js";

// The wedding details record: read, saved, submitted, unlocked. A row is
// made the first time a wedding booking's details are read.

const INCLUDE = {
  package: { select: { occasions: true } },
  customer: { select: { name: true, email: true, phone: true, homeAddress: true } },
  weddingDetails: true,
} as const;
type BookingRow = Prisma.BookingGetPayload<{ include: typeof INCLUDE }>;
type DetailsRow = NonNullable<BookingRow["weddingDetails"]>;

export class WeddingError extends Error {
  status: number;
  reason: string;
  extra: Record<string, unknown>;
  constructor(status: number, reason: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

const INTEREST_KEY = "content_creation.interested";
const INTERESTED = new Set(["yes", "maybe"]);
const MAX_NOTE = 1000;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const answersOf = (row: DetailsRow) => (row.answers ?? {}) as Answers;
const prefillOf = (b: BookingRow) => prefillFor({ ...b, eventDay: dayOf(b.eventDate) });
const who = (b: BookingRow) => `${b.customerName}, ${dayLabel(dayOf(b.eventDate))}.`;

// Safe when two reads race: the unique booking id decides.
const ensureRow = (b: BookingRow): Promise<DetailsRow> =>
  b.weddingDetails ? Promise.resolve(b.weddingDetails) : prisma.weddingDetails.upsert({ where: { bookingId: b.id }, update: {}, create: { accountId: b.accountId, bookingId: b.id, templateVersion: CURRENT_TEMPLATE_VERSION } });

// A wedding booking that belongs to this customer, or null: the routes answer
// a plain 404 either way, so nobody learns what else exists.
async function ownWedding(bookingId: string, customerId: string): Promise<BookingRow | null> {
  const b = await prisma.booking.findFirst({ where: { id: bookingId, customerId }, include: INCLUDE });
  return b && isWeddingBooking(b) ? b : null;
}

function customerShape(b: BookingRow, row: DetailsRow) {
  const prefill = prefillOf(b);
  const template = templateFor(row.templateVersion);
  const answers = answersOf(row);
  return {
    bookingId: b.id,
    templateVersion: row.templateVersion,
    template,
    answers,
    prefill,
    lockedKeys: Object.keys(prefill),
    status: row.status as WeddingStatus,
    eventDate: dayOf(b.eventDate),
    dueDate: dueDateFor(dayOf(b.eventDate)),
    submittedAt: row.submittedAt,
    changeRequestedAt: row.changeRequestedAt,
    ...sectionProgress(template, answers),
  };
}

// Never lets a notification fail the customer's save.
async function raise(rows: NotificationInput[]) {
  try {
    await createNotifications(rows);
  } catch (err) {
    console.warn("[wedding details] notification not recorded:", safeErr(err));
  }
}

const noticeBase = (b: BookingRow) => ({ accountId: b.accountId, link: bookingLink(b.id), bookingId: b.id, leadId: b.leadId, customerId: b.customerId });
// Each unlock starts a new round, so a resubmission is news again.
const roundOf = (row: DetailsRow) => row.unlockedAt?.getTime() ?? 0;

// Reads and writes under a row lock, so two quick saves can't lose an answer
// and a save can't slip in beside a submit.
function locked<T>(id: string, fn: (tx: Prisma.TransactionClient, row: DetailsRow) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM wedding_details WHERE id = ${id} FOR UPDATE`;
    return fn(tx, await tx.weddingDetails.findUniqueOrThrow({ where: { id } }));
  });
}

// ---- Customer -----------------------------------------------------------

export async function customerView(bookingId: string, customerId: string) {
  const b = await ownWedding(bookingId, customerId);
  if (!b) return null;
  return customerShape(b, await ensureRow(b));
}

export async function saveAnswers(bookingId: string, customerId: string, patch: unknown) {
  const b = await ownWedding(bookingId, customerId);
  if (!b) return null;
  const row = await ensureRow(b);
  const cleaned = cleanAnswers(templateFor(row.templateVersion), patch, new Set(Object.keys(prefillOf(b))));
  if ("reason" in cleaned) throw new WeddingError(400, cleaned.reason, cleaned.error, { field: cleaned.field });
  const updated = await locked(row.id, (tx, fresh) => {
    if (fresh.status === "submitted") throw new WeddingError(409, "submitted", "These details are submitted. Ask GO to open them for changes.");
    const answers = mergeAnswers(answersOf(fresh), cleaned.values);
    return tx.weddingDetails.update({ where: { id: fresh.id }, data: { answers: answers as Prisma.InputJsonObject, status: Object.keys(answers).length > 0 ? "in_progress" : "not_started" } });
  });
  const interest = cleaned.values[INTEREST_KEY];
  if (typeof interest === "string" && INTERESTED.has(interest)) {
    const label = interest === "yes" ? "Yes, add it" : "Maybe, tell me more";
    await raise([{ ...noticeBase(b), type: "content-creation-interest", title: "Upsell: content creation", body: `${who(b)} Answered "${label}".`, dedupeKey: `content-creation-interest:${b.id}` }]);
  }
  return customerShape(b, updated);
}

export async function submitDetails(bookingId: string, customerId: string, customer: { name: string | null; email: string }) {
  const b = await ownWedding(bookingId, customerId);
  if (!b) return null;
  const row = await ensureRow(b);
  const updated = await locked(row.id, (tx, fresh) => {
    if (fresh.status === "submitted") throw new WeddingError(409, "submitted", "These details are already submitted.");
    const { missing } = sectionProgress(templateFor(fresh.templateVersion), answersOf(fresh));
    if (missing.length > 0) throw new WeddingError(400, "sections-missing", `Finish these sections first: ${missing.map((m) => m.title).join(", ")}.`, { missing });
    return tx.weddingDetails.update({ where: { id: fresh.id }, data: { status: "submitted", submittedAt: new Date(), submittedBy: customer.name?.trim() || customer.email } });
  });
  await raise([{ ...noticeBase(b), type: "wedding-details-submitted", title: "Wedding details submitted", body: `${who(b)} Ready to review.`, dedupeKey: `wedding-details-submitted:${b.id}:${roundOf(updated)}` }]);
  return customerShape(b, updated);
}

// Records the request and tells staff. It does not unlock: staff decide. A
// second press while one is open changes nothing.
export async function requestChange(bookingId: string, customerId: string, note: unknown) {
  const b = await ownWedding(bookingId, customerId);
  if (!b) return null;
  if (note !== undefined && note !== null && typeof note !== "string") throw new WeddingError(400, "invalid-answer", "note must be text");
  const text = typeof note === "string" ? safeText(note, MAX_NOTE) : "";
  const row = await ensureRow(b);
  const updated = await locked(row.id, async (tx, fresh) => {
    if (fresh.status !== "submitted") throw new WeddingError(409, "not-submitted", "These details aren't submitted, so you can still change them.");
    if (fresh.changeRequestedAt) return fresh;
    return tx.weddingDetails.update({ where: { id: fresh.id }, data: { changeRequestedAt: new Date(), changeRequestNote: text || null } });
  });
  await raise([{ ...noticeBase(b), type: "wedding-details-change-request", title: "Wedding details change requested", body: `${who(b)}${updated.changeRequestNote ? ` ${updated.changeRequestNote.slice(0, 160)}` : " Wants to change submitted details."}`, dedupeKey: `wedding-details-change-request:${b.id}:${roundOf(updated)}` }]);
  return customerShape(b, updated);
}

// ---- Staff --------------------------------------------------------------

async function staffBooking(bookingId: string, accountId: string): Promise<BookingRow | null> {
  return prisma.booking.findFirst({ where: { id: bookingId, accountId }, include: INCLUDE });
}

export async function staffView(bookingId: string, accountId: string) {
  const b = await staffBooking(bookingId, accountId);
  if (!b) return null;
  const base = { bookingId: b.id, isWedding: isWeddingBooking(b), weddingOverride: b.weddingOverride, automatic: automaticWedding(b) };
  if (!base.isWedding) return { ...base, details: null };
  const row = await ensureRow(b);
  const template = templateFor(row.templateVersion);
  const answers = answersOf(row);
  const { requiredDone, requiredTotal } = sectionProgress(template, answers);
  return {
    ...base,
    details: {
      status: row.status as WeddingStatus,
      templateVersion: row.templateVersion,
      eventDate: dayOf(b.eventDate),
      dueDate: dueDateFor(dayOf(b.eventDate)),
      requiredDone,
      requiredTotal,
      submittedAt: row.submittedAt,
      submittedBy: row.submittedBy,
      unlockedAt: row.unlockedAt,
      unlockReason: row.unlockReason,
      changeRequestedAt: row.changeRequestedAt,
      changeRequestNote: row.changeRequestNote,
      sections: shownSections(template, answers, prefillOf(b)),
    },
  };
}

export async function unlockDetails(bookingId: string, accountId: string, reason: unknown) {
  const b = await staffBooking(bookingId, accountId);
  if (!b || !isWeddingBooking(b)) return null;
  const text = typeof reason === "string" ? safeText(reason, MAX_NOTE) : "";
  if (!text) throw new WeddingError(400, "reason-required", "Say why these details are being opened.");
  const row = await ensureRow(b);
  await locked(row.id, (tx, fresh) => {
    if (fresh.status !== "submitted") throw new WeddingError(409, "not-submitted", "These details aren't submitted.");
    return tx.weddingDetails.update({ where: { id: fresh.id }, data: { status: "in_progress", submittedAt: null, submittedBy: null, unlockedAt: new Date(), unlockReason: text, changeRequestedAt: null, changeRequestNote: null } });
  });
  await audit("wedding details unlocked", b.id);
  return staffView(bookingId, accountId);
}

export async function setWeddingOverride(bookingId: string, accountId: string, value: unknown) {
  if (value !== null && typeof value !== "boolean") throw new WeddingError(400, "invalid-answer", "weddingOverride must be true, false or null");
  const updated = await prisma.booking.updateMany({ where: { id: bookingId, accountId }, data: { weddingOverride: value } });
  if (updated.count === 0) return null;
  await audit("wedding switch changed", `${bookingId}: ${value === null ? "automatic" : value ? "on" : "off"}`);
  return staffView(bookingId, accountId);
}

export async function printView(bookingId: string, accountId: string) {
  const b = await staffBooking(bookingId, accountId);
  if (!b || !isWeddingBooking(b)) return null;
  const row = await ensureRow(b);
  const template = templateFor(row.templateVersion);
  const answers = answersOf(row);
  const prefill = prefillOf(b);
  return {
    template,
    bride: (prefill["couple.bride_name"] ?? answers["couple.bride_name"] ?? "") as string,
    groom: (answers["couple.groom_name"] ?? "") as string,
    eventDate: dayLabel(dayOf(b.eventDate)),
    dueDate: dayLabel(dueDateFor(dayOf(b.eventDate))),
    status: row.status as WeddingStatus,
    sections: shownSections(template, answers, prefill),
  };
}
