import { prisma } from "./db.js";
import { getSettings } from "./settings.js";
import { TOKEN_CATALOG, camelToSnake } from "./tokens.js";
import { toE164 } from "./messaging.js";
import { todayEastern } from "./validate.js";
import { humanWhen } from "./automation/time.js";

// What a message is about. Point at the records; the values for every
// merge token are read from them. extra carries values only the caller
// has at that moment (a freshly made contract link).
export type MessageContext = {
  bookingId?: string | null;
  leadId?: string | null;
  designRequestId?: string | null;
  crewMemberId?: string | null;
  gigId?: string | null;
  // The crew offer the message is about: its link, bid and deadline.
  offerId?: string | null;
  extra?: Record<string, string>;
};

export const COMPANY_NAME = "GO! Event Group";

const wholeDollars = (n: number) => `$${n.toLocaleString("en-US")}`;
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const firstName = (full: string | null | undefined) => (full ?? "").trim().split(/\s+/)[0] ?? "";

function prettyPhone(raw: string | null | undefined): string {
  const e164 = toE164(raw);
  if (!e164) return raw?.trim() ?? "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function daysBetween(fromEastern: string, to: Date): number {
  return Math.round((to.getTime() - new Date(`${fromEastern}T00:00:00Z`).getTime()) / 86_400_000);
}

type Settings = Awaited<ReturnType<typeof getSettings>>;

// The records a message can be about, already loaded. composeValues turns
// them into token values with no database access, so the scheduler can fill
// tokens for hundreds of records from a handful of queries.
export type LoadedRecords = {
  lead?: { customerName: string | null; occasion: string | null; dateOfInterest: Date | null } | null;
  designRequest?: { customerName: string; eventDate: Date; eventTime: string | null; occasion: string | null; address: string | null; total: unknown } | null;
  booking?: { customerName: string; eventDate: Date; eventTime: string | null; occasion: string | null; address: string | null; total: unknown } | null;
  crew?: { name: string } | null;
  gig?: {
    skill: string;
    itemName: string;
    eventDate: Date;
    payMin?: number | null;
    payMax?: number | null;
    town?: string | null;
    startTime?: string | null;
    booking: { eventTime: string | null; address: string | null };
  } | null;
  offer?: { token: string | null; bidAmount: number | null; deadlineAt: Date | null } | null;
  extra?: Record<string, string>;
};

// Values keyed by snake_case (the resolver's spelling). A token with no
// data behind it is simply absent or empty, and the pipeline blocks the
// message rather than sending a hole.
export function composeValues(settings: Settings, rec: LoadedRecords): Record<string, string> {
  const v: Record<string, string> = {};
  const set = (camel: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined) v[camelToSnake(camel)] = value;
  };

  const storefront = process.env.STOREFRONT_URL?.replace(/\/$/, "");
  set("companyName", COMPANY_NAME);
  set("companyPhone", settings.rushContactPhone?.trim() || prettyPhone(process.env.TWILIO_PHONE_NUMBER));
  set("depositPercentage", String(settings.depositPercentage));
  set("cancellationWindowDays", String(settings.cancellationWindowDays));
  set("portalLink", storefront ? `${storefront}/party` : "");
  // Nothing is asked of an event type that isn't known: "your event".
  set("eventType", "event");

  const applyMoney = (total: unknown) => {
    if (total === null || total === undefined) return;
    const t = Number(total);
    const deposit = Math.round(t * settings.depositPercentage) / 100;
    set("depositAmount", usd(deposit));
    set("balanceDue", usd(Math.round((t - deposit) * 100) / 100));
  };
  const applyEvent = (e: { name?: string | null; date?: Date | null; time?: string | null; type?: string | null; address?: string | null }) => {
    set("customerName", e.name?.trim());
    set("customerFirstName", firstName(e.name));
    if (e.date) {
      set("eventDate", shortDate(e.date));
      set("daysUntilEvent", String(Math.max(0, daysBetween(todayEastern(), e.date))));
    }
    set("eventTime", e.time?.trim());
    if (e.type?.trim()) set("eventType", e.type.trim());
    set("eventAddress", e.address?.trim());
  };

  // Lowest to highest priority: the lead, the request, then the booking.
  if (rec.lead) applyEvent({ name: rec.lead.customerName, date: rec.lead.dateOfInterest, type: rec.lead.occasion });
  if (rec.designRequest) {
    const r = rec.designRequest;
    applyEvent({ name: r.customerName, date: r.eventDate, time: r.eventTime, type: r.occasion, address: r.address });
    applyMoney(r.total);
  }
  if (rec.booking) {
    const b = rec.booking;
    applyEvent({ name: b.customerName, date: b.eventDate, time: b.eventTime, type: b.occasion, address: b.address });
    applyMoney(b.total);
  }
  if (rec.crew) set("crewFirstName", firstName(rec.crew.name));
  if (rec.gig) {
    set("gigRole", rec.gig.skill);
    set("gigItemName", rec.gig.itemName);
    set("gigDate", shortDate(rec.gig.eventDate));
    set("gigStartTime", (rec.gig.startTime ?? rec.gig.booking.eventTime)?.trim());
    set("gigAddress", rec.gig.booking.address?.trim());
    set("gigTown", rec.gig.town?.trim());
    if (rec.gig.payMin != null && rec.gig.payMax != null) set("bidRange", `${wholeDollars(rec.gig.payMin)} to ${wholeDollars(rec.gig.payMax)}`);
  }
  if (rec.offer) {
    // Crew pages live on the storefront. Without STOREFRONT_URL there is no
    // link to make, so the token stays empty and the send is blocked.
    if (storefront && rec.offer.token) {
      set("bidLink", `${storefront}/bid/${rec.offer.token}`);
      set("gigLink", `${storefront}/bid/${rec.offer.token}`);
    }
    // A gig accepted by hand has no bid; the text says the rate was agreed.
    set("bidAmount", rec.offer.bidAmount != null ? wholeDollars(rec.offer.bidAmount) : "the agreed rate");
    if (rec.offer.deadlineAt) set("bidDeadline", humanWhen(rec.offer.deadlineAt));
  }

  // Not available anywhere in the app yet: cartLink, holdExpiresAt,
  // gigTown, gigLink, bidLink, bidRange, bidAmount, bidDeadline. They stay
  // absent, so a message that uses one is blocked and says why.
  for (const [k, value] of Object.entries(rec.extra ?? {})) set(k, value);
  return v;
}

// Loads what the context points at, then composes the values.
export async function buildMessageValues(accountId: string, ctx: MessageContext): Promise<Record<string, string>> {
  const settings = await getSettings(accountId);
  const rec: LoadedRecords = { extra: ctx.extra };
  if (ctx.leadId) rec.lead = await prisma.lead.findUnique({ where: { id: ctx.leadId }, select: { customerName: true, occasion: true, dateOfInterest: true } });
  if (ctx.designRequestId) rec.designRequest = await prisma.designRequest.findUnique({ where: { id: ctx.designRequestId } });
  let bookingId = ctx.bookingId ?? null;
  if (!bookingId && ctx.gigId) {
    bookingId = (await prisma.gig.findUnique({ where: { id: ctx.gigId }, select: { bookingId: true } }))?.bookingId ?? null;
  }
  if (bookingId) rec.booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (ctx.crewMemberId) rec.crew = await prisma.crewMember.findUnique({ where: { id: ctx.crewMemberId }, select: { name: true } });
  if (ctx.gigId) rec.gig = await prisma.gig.findUnique({ where: { id: ctx.gigId }, include: { booking: { select: { eventTime: true, address: true } } } });
  if (ctx.offerId) rec.offer = await prisma.gigOffer.findUnique({ where: { id: ctx.offerId }, select: { token: true, bidAmount: true, deadlineAt: true } });
  return composeValues(settings, rec);
}

// Believable values for the editor's preview when there's no real record.
export function sampleValues(): Record<string, string> {
  return Object.fromEntries(TOKEN_CATALOG.map((t) => [camelToSnake(t.key), t.example]));
}
