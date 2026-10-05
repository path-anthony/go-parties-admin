import { randomBytes } from "node:crypto";
import { getDefaultAccount } from "./account.js";
import { addDays, atEastern } from "./automation/time.js";
import { prisma } from "./db.js";
import { safeErr } from "./log.js";
import { safeInline } from "./sanitize.js";
import { toE164 } from "./messaging.js";
import { sendTemplatedMessage } from "./sendTemplated.js";
import { getSettings } from "./settings.js";
import type { Prisma } from "../src/generated/prisma/client.js";

// The crew bidding marketplace: invite crew to bid on a gig, take bids from
// a public page (by unguessable token), and pick one. Everything that
// decides who wins lives here, so the bid page, the admin's Accept button and
// the old manual path all go through the same functions.
//
// Offer status (stored)      -> page state
//   Sent, no bid, in time    -> open
//   Sent, no bid, past due   -> expired
//   Sent with a bid          -> bid_submitted (stands after the deadline)
//   Accepted                 -> accepted
//   Not Selected             -> not_selected
//   Declined                 -> declined
//   any, gig Cancelled       -> expired

export type BidReason = "deadline-passed" | "already-filled" | "bid-invalid" | "not-open" | "rate-limited";
export type BidState = "open" | "bid_submitted" | "accepted" | "not_selected" | "expired" | "declined";

export class BidError extends Error {
  status: number;
  reason: BidReason | null;
  constructor(status: number, reason: BidReason | null, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export const MAX_NOTE = 200;
export const MAX_QUESTION = 500;
export const MAX_AMOUNT = 100_000;

export const newToken = () => randomBytes(24).toString("base64url");

const day = (d: Date) => d.toISOString().slice(0, 10);

// A link works through the end of the second day after the gig (Eastern).
export function tokenExpiresAt(eventDate: Date): Date {
  return atEastern(addDays(day(eventDate), 3), 0);
}

export function offerState(offer: { status: string; bidAmount: number | null; deadlineAt: Date | null }, gigStatus: string, now: Date): BidState {
  if (gigStatus === "Cancelled") return "expired";
  if (offer.status === "Accepted") return "accepted";
  if (offer.status === "Not Selected") return "not_selected";
  if (offer.status === "Declined") return "declined";
  if (offer.bidAmount !== null) return "bid_submitted";
  return offer.deadlineAt && now.getTime() > offer.deadlineAt.getTime() ? "expired" : "open";
}

export function rangeFlag(amount: number, min: number | null, max: number | null): "above range" | "below range" | null {
  if (max !== null && amount > max) return "above range";
  if (min !== null && amount < min) return "below range";
  return null;
}

// ---- what the page reads --------------------------------------------------

const PAGE_INCLUDE = {
  gig: { include: { booking: { select: { address: true, eventTime: true } } } },
  crewMember: { select: { name: true } },
  questions: { orderBy: { createdAt: "asc" as const }, select: { text: true, createdAt: true } },
} satisfies Prisma.GigOfferInclude;

type PageOffer = Prisma.GigOfferGetPayload<{ include: typeof PAGE_INCLUDE }>;

export async function contactPhone(): Promise<string> {
  const account = await getDefaultAccount();
  const s = await getSettings(account.id);
  return toE164(s.staffNotifyPhone) ?? toE164(s.rushContactPhone) ?? toE164(process.env.TWILIO_PHONE_NUMBER) ?? "";
}

// The one place a crew page response is built, field by field. Nothing here
// reads the customer's name, phone, email or the booking id, so they cannot
// leak. Address, notes, contact phone, crew first name and questions are
// added only when this offer is accepted.
export function serializeBid(offer: PageOffer, now: Date, phone: string) {
  const g = offer.gig;
  const state = offerState(offer, g.status, now);
  const out: Record<string, unknown> = {
    state,
    role: g.skill,
    eventType: g.eventType ?? "Event",
    guestCount: g.guestCount,
    eventDate: day(g.eventDate),
    startTime: g.startTime,
    endTime: g.endTime,
    town: g.town,
    payRange: { min: g.payMin ?? 0, max: g.payMax ?? 0 },
    deadlineAt: (offer.deadlineAt ?? offer.createdAt).toISOString(),
    myBid: offer.bidAmount === null ? null : { amount: offer.bidAmount, note: offer.bidNote, submittedAt: offer.bidSubmittedAt?.toISOString() ?? null },
  };
  if (state === "accepted") {
    out.address = g.booking.address;
    out.arrivalNotes = g.arrivalNotes;
    out.contactPhone = phone;
    out.crewFirstName = offer.crewMember.name.trim().split(/\s+/)[0] ?? "";
    out.confirmedAt = offer.confirmedAt?.toISOString() ?? null;
    out.questions = offer.questions.map((q) => ({ text: q.text, createdAt: q.createdAt.toISOString() }));
  }
  return out;
}

export async function loadByToken(token: string, now: Date): Promise<PageOffer | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const offer = await prisma.gigOffer.findUnique({ where: { token }, include: PAGE_INCLUDE });
  if (!offer || now.getTime() >= tokenExpiresAt(offer.gig.eventDate).getTime()) return null;
  return offer;
}

export async function getBidPage(token: string, now = new Date()) {
  const offer = await loadByToken(token, now);
  return offer ? serializeBid(offer, now, await contactPhone()) : null;
}

// ---- locking ---------------------------------------------------------------

type Tx = Prisma.TransactionClient;

// Everything that changes who holds a gig takes this row lock first, so an
// accept and a bid edit cannot both win.
async function lockGig(tx: Tx, gigId: string) {
  await tx.$queryRaw`SELECT id FROM gigs WHERE id = ${gigId} FOR UPDATE`;
}

async function reload(tx: Tx, token: string, now: Date): Promise<PageOffer> {
  const offer = await tx.gigOffer.findUnique({ where: { token }, include: PAGE_INCLUDE });
  if (!offer || now.getTime() >= tokenExpiresAt(offer.gig.eventDate).getTime()) throw new BidError(404, null, "That link isn't valid.");
  return offer;
}

// ---- crew actions ----------------------------------------------------------

export async function submitBid(token: string, body: unknown, now = new Date()) {
  const b = (body ?? {}) as { amount?: unknown; note?: unknown };
  const amount = b.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) throw new BidError(400, "bid-invalid", "Enter a whole dollar amount.");
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || b.note.length > MAX_NOTE) throw new BidError(400, "bid-invalid", `A note can be up to ${MAX_NOTE} characters.`);
    note = b.note.trim() || null;
  }
  const first = await loadByToken(token, now);
  if (!first) throw new BidError(404, null, "That link isn't valid.");

  await prisma.$transaction(async (tx) => {
    await lockGig(tx, first.gigId);
    const o = await reload(tx, token, now);
    const state = offerState(o, o.gig.status, now);
    if (o.gig.status === "Filled" || state === "not_selected") throw new BidError(409, "already-filled", "Someone else already has this gig.");
    if (state === "accepted" || state === "declined") throw new BidError(409, "not-open", "This gig isn't taking bids from you.");
    if (o.gig.status === "Cancelled") throw new BidError(409, "not-open", "This gig was cancelled.");
    if (o.deadlineAt && now.getTime() > o.deadlineAt.getTime()) throw new BidError(409, "deadline-passed", "Bids have closed.");
    await tx.gigOffer.update({ where: { id: o.id }, data: { bidAmount: amount, bidNote: note, bidSubmittedAt: now } });
  });
  return (await getBidPage(token, now)) as Record<string, unknown>;
}

export async function declineBid(token: string, now = new Date()) {
  const first = await loadByToken(token, now);
  if (!first) throw new BidError(404, null, "That link isn't valid.");
  await prisma.$transaction(async (tx) => {
    await lockGig(tx, first.gigId);
    const o = await reload(tx, token, now);
    const state = offerState(o, o.gig.status, now);
    if (state === "declined") return;
    if (state === "not_selected") throw new BidError(409, "already-filled", "Someone else already has this gig.");
    if (state !== "open" && state !== "bid_submitted") throw new BidError(409, "not-open", "This gig isn't open.");
    await tx.gigOffer.update({ where: { id: o.id }, data: { status: "Declined", declinedAt: now } });
    const open = await tx.gigOffer.count({ where: { gigId: o.gigId, status: "Sent", id: { not: o.id } } });
    if (o.gig.status === "Offered" && open === 0) await tx.gig.update({ where: { id: o.gigId }, data: { status: "Needs Crew" } });
  });
  return (await getBidPage(token, now)) as Record<string, unknown>;
}

export async function confirmSet(token: string, now = new Date()) {
  const first = await loadByToken(token, now);
  if (!first) throw new BidError(404, null, "That link isn't valid.");
  if (offerState(first, first.gig.status, now) !== "accepted") throw new BidError(409, "not-open", "Only an accepted gig can be confirmed.");
  const at = first.confirmedAt ?? now;
  if (!first.confirmedAt) await prisma.gigOffer.update({ where: { id: first.id }, data: { confirmedAt: at } });
  return { confirmedAt: at.toISOString() };
}

export async function askQuestion(token: string, text: unknown, now = new Date()) {
  const first = await loadByToken(token, now);
  if (!first) throw new BidError(404, null, "That link isn't valid.");
  if (offerState(first, first.gig.status, now) !== "accepted") throw new BidError(409, "not-open", "Only an accepted gig can ask a question.");
  const t = typeof text === "string" ? text.trim() : "";
  if (t === "" || t.length > MAX_QUESTION) throw new BidError(400, "bid-invalid", `A question can be 1 to ${MAX_QUESTION} characters.`);
  const q = await prisma.gigQuestion.create({ data: { offerId: first.id, text: t } });
  try {
    const account = await getDefaultAccount();
    const staff = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { staffNotifyPhone: true, staffNotifyEmail: true } });
    await sendTemplatedMessage(
      "staff_crew_question",
      { gigId: first.gigId, crewMemberId: first.crewMemberId, extra: { questionText: safeInline(t, MAX_QUESTION), adminLink: `${adminBase()}/crew/gigs?gig=${first.gigId}` } },
      { phone: staff.staffNotifyPhone, email: staff.staffNotifyEmail },
      `staff_crew_question:${q.id}`,
      { purpose: "crew-question" },
    );
  } catch (err) {
    console.error("[bids] could not notify staff of a crew question:", safeErr(err));
  }
  return { ok: true as const };
}

function adminBase(): string {
  return (process.env.PUBLIC_API_URL?.replace(/\/$/, "") ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""));
}

// ---- accepting -------------------------------------------------------------

export type AcceptResult = { gigId: string; winner: { offerId: string; crewMemberId: string }; notSelected: { offerId: string; crewMemberId: string }[] };

// The one accept. In one transaction, under the gig's row lock: the winner
// becomes Accepted, every other offer that has not declined becomes Not
// Selected, the gig becomes Filled. A gig already filled by someone else is
// refused. Messages go out separately, after commit (see notifyAccepted).
export async function acceptOffer(gigId: string, offerId: string): Promise<AcceptResult> {
  return prisma.$transaction(async (tx) => {
    await lockGig(tx, gigId);
    const gig = await tx.gig.findUnique({ where: { id: gigId }, include: { offers: { include: { crewMember: { select: { name: true } } } }, filledBy: { select: { name: true } } } });
    const offer = gig?.offers.find((o) => o.id === offerId);
    if (!gig || !offer) throw new BidError(404, null, "offer not found");
    if (gig.status === "Cancelled") throw new BidError(400, null, "This gig was cancelled with its booking.");
    if (gig.status === "Filled" && gig.filledById !== offer.crewMemberId) {
      throw new BidError(409, "already-filled", `${gig.itemName} is already filled by ${gig.filledBy?.name ?? "someone else"}. Decline their offer first if ${offer.crewMember.name} should take it instead.`);
    }
    const losers = gig.offers.filter((o) => o.id !== offerId && o.status === "Sent");
    await tx.gigOffer.update({ where: { id: offerId }, data: { status: "Accepted", token: offer.token ?? newToken() } });
    if (losers.length > 0) await tx.gigOffer.updateMany({ where: { id: { in: losers.map((l) => l.id) } }, data: { status: "Not Selected" } });
    await tx.gig.update({ where: { id: gigId }, data: { status: "Filled", filledById: offer.crewMemberId } });
    return { gigId, winner: { offerId, crewMemberId: offer.crewMemberId }, notSelected: losers.map((l) => ({ offerId: l.id, crewMemberId: l.crewMemberId })) };
  });
}

// After the accept has committed: tell the winner, and everyone else who
// was still in the running. A message that can't go never undoes the accept.
export async function notifyAccepted(r: AcceptResult): Promise<void> {
  const people = await prisma.crewMember.findMany({ where: { id: { in: [r.winner.crewMemberId, ...r.notSelected.map((n) => n.crewMemberId)] } }, select: { id: true, phone: true, email: true } });
  const by = new Map(people.map((p) => [p.id, p]));
  const send = async (trigger: string, offerId: string, crewMemberId: string) => {
    const p = by.get(crewMemberId);
    if (!p) return;
    try {
      await sendTemplatedMessage(trigger, { gigId: r.gigId, crewMemberId, offerId }, { phone: p.phone, email: p.email }, `${trigger}:${offerId}`, { purpose: trigger });
    } catch (err) {
      console.error(`[bids] ${trigger} failed:`, safeErr(err));
    }
  };
  await send("bid_accepted", r.winner.offerId, r.winner.crewMemberId);
  for (const n of r.notSelected) await send("bid_not_selected", n.offerId, n.crewMemberId);
}

// ---- prefill ---------------------------------------------------------------

function fmtTime(h: number, m: number, pm: boolean): string {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""} ${pm ? "PM" : "AM"}`;
}

// "2 PM", "noon to 4", "6-10pm" -> { start: "2 PM", end: null } etc.
// Anything that can't be read cleanly returns nulls; staff fill it in.
export function parseTimes(text: string | null | undefined): { start: string | null; end: string | null } {
  if (!text) return { start: null, end: null };
  const found: { h: number; m: number; pm: boolean | null }[] = [];
  const re = /\b(noon|midnight)\b|\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;
  for (const m of text.matchAll(re)) {
    if (m[1]) found.push({ h: 12, m: 0, pm: m[1].toLowerCase() === "noon" });
    else {
      const h = Number(m[2]);
      if (h < 1 || h > 12) continue;
      found.push({ h, m: m[3] ? Number(m[3]) : 0, pm: m[4] ? m[4].toLowerCase().startsWith("p") : null });
    }
  }
  const two = found.slice(0, 2);
  if (two.length === 0) return { start: null, end: null };
  // A missing AM or PM is borrowed from the other end.
  const known = two.find((t) => t.pm !== null)?.pm ?? null;
  if (known === null) return { start: null, end: null };
  const fmt = (t: (typeof two)[number]) => fmtTime(t.h, t.m, t.pm ?? known);
  return { start: fmt(two[0]), end: two[1] ? fmt(two[1]) : null };
}

const STATE_LIKE = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;

// "12 Main St, Farmington, CT 06032" -> "Farmington".
export function parseTown(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3 && STATE_LIKE.test(parts[parts.length - 1])) return parts[parts.length - 2];
  if (parts.length === 2 && !STATE_LIKE.test(parts[1]) && !/\d/.test(parts[1])) return parts[1];
  return null;
}

export function prefillFromBooking(b: { address: string | null; eventTime: string | null; occasion: string | null }) {
  const t = parseTimes(b.eventTime);
  return { eventType: b.occasion?.trim() || null, startTime: t.start, endTime: t.end, town: parseTown(b.address), guestCount: null as number | null };
}

// ---- inviting --------------------------------------------------------------

export type InviteInput = {
  crewMemberIds: string[];
  payMin: number;
  payMax: number;
  deadlineAt: Date;
  fields?: Partial<{ eventType: string | null; guestCount: number | null; startTime: string | null; endTime: string | null; town: string | null; arrivalNotes: string | null }>;
};

export async function inviteBids(gigId: string, input: InviteInput, now = new Date()) {
  const { payMin, payMax } = input;
  if (![payMin, payMax].every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT) || payMin > payMax) throw new BidError(400, null, "Set a pay range: both a minimum and a maximum, whole dollars, minimum not above maximum.");
  if (!(input.deadlineAt.getTime() > now.getTime())) throw new BidError(400, null, "The deadline has to be in the future.");
  if (input.crewMemberIds.length === 0) throw new BidError(400, null, "Pick at least one crew member.");

  const fresh = await prisma.$transaction(async (tx) => {
    await lockGig(tx, gigId);
    const gig = await tx.gig.findUnique({ where: { id: gigId }, include: { booking: { select: { address: true, eventTime: true, occasion: true } }, offers: true } });
    if (!gig) throw new BidError(404, null, "gig not found");
    if (gig.status === "Cancelled") throw new BidError(400, null, "This gig was cancelled with its booking.");
    if (gig.status === "Filled") throw new BidError(409, "already-filled", "This gig is already filled.");
    const eligible = await tx.crewMember.findMany({ where: { id: { in: input.crewMemberIds }, accountId: gig.accountId, active: true, skills: { has: gig.skill } }, select: { id: true, name: true } });
    if (eligible.length !== new Set(input.crewMemberIds).size) throw new BidError(400, null, `Every person invited has to be active and have the ${gig.skill} skill.`);

    const pre = prefillFromBooking(gig.booking);
    const f = input.fields ?? {};
    const pick = <K extends keyof typeof pre>(k: K, current: (typeof pre)[K]) => (f[k as keyof typeof f] !== undefined ? (f[k as keyof typeof f] as (typeof pre)[K]) : (current ?? pre[k]));
    const town = pick("town", gig.town);
    if (!town || !String(town).trim()) throw new BidError(400, null, "Set the town before inviting bids. The invite text names it and the bid page shows it.");
    await tx.gig.update({
      where: { id: gigId },
      data: {
        payMin,
        payMax,
        town: String(town).trim(),
        eventType: pick("eventType", gig.eventType),
        guestCount: pick("guestCount", gig.guestCount),
        startTime: pick("startTime", gig.startTime),
        endTime: pick("endTime", gig.endTime),
        ...(f.arrivalNotes !== undefined ? { arrivalNotes: f.arrivalNotes } : {}),
      },
    });

    const out: { offerId: string; crewMemberId: string }[] = [];
    for (const m of eligible) {
      const existing = gig.offers.find((o) => o.crewMemberId === m.id);
      if (!existing) {
        const o = await tx.gigOffer.create({ data: { gigId, crewMemberId: m.id, token: newToken(), deadlineAt: input.deadlineAt } });
        out.push({ offerId: o.id, crewMemberId: m.id });
      } else if (existing.status === "Sent" && !existing.token) {
        // An offer from before bidding existed: give it a link and invite it.
        await tx.gigOffer.update({ where: { id: existing.id }, data: { token: newToken(), deadlineAt: input.deadlineAt } });
        out.push({ offerId: existing.id, crewMemberId: m.id });
      }
    }
    if (gig.status === "Needs Crew" && (out.length > 0 || gig.offers.length > 0)) await tx.gig.update({ where: { id: gigId }, data: { status: "Offered" } });
    return { invited: out, skipped: eligible.length - out.length, gig };
  });

  const people = await prisma.crewMember.findMany({ where: { id: { in: fresh.invited.map((i) => i.crewMemberId) } }, select: { id: true, phone: true, email: true } });
  const messages = [];
  for (const i of fresh.invited) {
    const p = people.find((x) => x.id === i.crewMemberId);
    let status = "not-sent";
    let error: string | null = null;
    try {
      const outcomes = await sendTemplatedMessage("gig_bid_invite", { gigId, crewMemberId: i.crewMemberId, offerId: i.offerId }, { phone: p?.phone ?? null, email: p?.email ?? null }, `gig_bid_invite:${i.offerId}`, { purpose: "gig-offer", now });
      const sms = outcomes.find((o) => o.channel === "sms") ?? outcomes[0];
      status = sms?.status ?? "not-sent";
      error = sms?.error ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : "failed";
    }
    messages.push({ crewMemberId: i.crewMemberId, offerId: i.offerId, status, error });
  }
  return { offered: fresh.invited.length, skipped: fresh.skipped, messages };
}

export async function extendDeadline(gigId: string, deadlineAt: Date, now = new Date()) {
  if (!(deadlineAt.getTime() > now.getTime())) throw new BidError(400, null, "The new deadline has to be in the future.");
  return prisma.$transaction(async (tx) => {
    await lockGig(tx, gigId);
    const gig = await tx.gig.findUnique({ where: { id: gigId }, select: { status: true } });
    if (!gig) throw new BidError(404, null, "gig not found");
    if (gig.status === "Filled" || gig.status === "Cancelled") throw new BidError(409, "not-open", "This gig is no longer taking bids.");
    const r = await tx.gigOffer.updateMany({ where: { gigId, status: "Sent", token: { not: null } }, data: { deadlineAt } });
    return { extended: r.count };
  });
}
