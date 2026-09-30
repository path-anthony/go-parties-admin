import { prisma } from "./db.js";
import { getSettings } from "./settings.js";
import { TOKEN_CATALOG, camelToSnake } from "./tokens.js";
import { toE164 } from "./messaging.js";
import { todayEastern } from "./validate.js";

// What a message is about. Point at the records; the values for every
// merge token are read from them. extra carries values only the caller
// has at that moment (a freshly made contract link).
export type MessageContext = {
  bookingId?: string | null;
  leadId?: string | null;
  designRequestId?: string | null;
  crewMemberId?: string | null;
  gigId?: string | null;
  extra?: Record<string, string>;
};

export const COMPANY_NAME = "GO! Event Group";

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

// Values keyed by snake_case (the resolver's spelling). A token with no
// data behind it is simply absent or empty, and the pipeline blocks the
// message rather than sending a hole.
export async function buildMessageValues(accountId: string, ctx: MessageContext): Promise<Record<string, string>> {
  const settings = await getSettings(accountId);
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

  const applyMoney = (total: number | null) => {
    if (total === null) return;
    const deposit = Math.round(total * settings.depositPercentage) / 100;
    set("depositAmount", usd(deposit));
    set("balanceDue", usd(Math.round((total - deposit) * 100) / 100));
  };
  const applyEvent = (e: { name?: string | null; date?: Date | null; time?: string | null; type?: string | null; address?: string | null }) => {
    set("customerName", e.name?.trim());
    set("customerFirstName", firstName(e.name));
    if (e.date) {
      set("eventDate", shortDate(e.date));
      set("daysUntilEvent", String(Math.max(0, daysBetween(todayEastern(), e.date))));
    }
    set("eventTime", e.time?.trim());
    set("eventType", e.type?.trim());
    set("eventAddress", e.address?.trim());
  };

  // Lowest to highest priority: the lead, the request, then the booking.
  if (ctx.leadId) {
    const l = await prisma.lead.findUnique({ where: { id: ctx.leadId }, select: { customerName: true, occasion: true, dateOfInterest: true } });
    if (l) applyEvent({ name: l.customerName, date: l.dateOfInterest, type: l.occasion });
  }
  if (ctx.designRequestId) {
    const r = await prisma.designRequest.findUnique({ where: { id: ctx.designRequestId } });
    if (r) {
      applyEvent({ name: r.customerName, date: r.eventDate, time: r.eventTime, type: r.occasion, address: r.address });
      applyMoney(r.total === null ? null : Number(r.total));
    }
  }
  let bookingId = ctx.bookingId ?? null;
  if (!bookingId && ctx.gigId) {
    bookingId = (await prisma.gig.findUnique({ where: { id: ctx.gigId }, select: { bookingId: true } }))?.bookingId ?? null;
  }
  if (bookingId) {
    const b = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (b) {
      applyEvent({ name: b.customerName, date: b.eventDate, time: b.eventTime, type: b.occasion, address: b.address });
      applyMoney(b.total === null ? null : Number(b.total));
    }
  }

  if (ctx.crewMemberId) {
    const c = await prisma.crewMember.findUnique({ where: { id: ctx.crewMemberId }, select: { name: true } });
    set("crewFirstName", firstName(c?.name));
  }
  if (ctx.gigId) {
    const g = await prisma.gig.findUnique({ where: { id: ctx.gigId }, include: { booking: { select: { eventTime: true, address: true } } } });
    if (g) {
      set("gigRole", g.skill);
      set("gigItemName", g.itemName);
      set("gigDate", shortDate(g.eventDate));
      set("gigStartTime", g.booking.eventTime?.trim());
      set("gigAddress", g.booking.address?.trim());
    }
  }

  // Not available anywhere in the app yet: cartLink, holdExpiresAt,
  // gigTown, gigLink, bidLink, bidRange, bidAmount, bidDeadline. They stay
  // absent, so a message that uses one is blocked and says why.
  for (const [k, value] of Object.entries(ctx.extra ?? {})) set(k, value);
  return v;
}

// Believable values for the editor's preview when there's no real record.
export function sampleValues(): Record<string, string> {
  return Object.fromEntries(TOKEN_CATALOG.map((t) => [camelToSnake(t.key), t.example]));
}
