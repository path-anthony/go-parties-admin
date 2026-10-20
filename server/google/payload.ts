import { createHash } from "node:crypto";
import { addDays, atEastern } from "../automation/time.js";
import { parseTimes } from "../bids.js";
import { safeInline } from "../sanitize.js";
import type { EventPayload, EventTime } from "./client.js";

// What goes on the calendar, as plain functions with no database: GO's own
// event (internal, no attendees, ever) and the customer's invite (customer-
// safe, the customer as the only guest). Both built field by field.

export const TIME_ZONE = "America/New_York";

export type BookingForCalendar = {
  id: string;
  customerName: string;
  occasion: string | null;
  eventDate: string; // YYYY-MM-DD
  eventTime: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  address: string | null;
  venueName: string | null;
  onsiteContactName: string | null;
  onsiteContactPhone: string | null;
  phone: string | null;
  email: string | null;
  items: { name: string; quantity: number }[];
  crew: { name: string; role: string }[];
};

export type CompanyForCalendar = { name: string; phone: string; email: string; portalUrl: string | null; adminUrl: string };

// "2 PM" -> { h: 14, m: 0 }
function clock(text: string): { h: number; m: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return { h, m: m[2] ? Number(m[2]) : 0 };
}

// The event's time: the contract's from and to when both are set, else the
// booking's free-text time when it reads cleanly ("2 PM to 6 PM"), else the
// whole day. A start with no end lasts four hours. All in America/New_York.
export function eventTimes(b: Pick<BookingForCalendar, "eventDate" | "eventTime" | "timeFrom" | "timeTo">): { start: EventTime; end: EventTime; allDay: boolean } {
  const fromText = b.timeFrom?.trim() || null;
  const toText = b.timeTo?.trim() || null;
  let from = fromText ? clock(fromText) : null;
  let to = toText ? clock(toText) : null;
  if (!from) {
    const parsed = parseTimes(fromText && toText ? `${fromText} to ${toText}` : b.eventTime);
    from = parsed.start ? clock(parsed.start) : null;
    to = parsed.end ? clock(parsed.end) : to;
  }
  if (!from) {
    return { start: { date: b.eventDate }, end: { date: addDays(b.eventDate, 1) }, allDay: true };
  }
  const startAt = atEastern(b.eventDate, from.h, from.m);
  let endAt = to ? atEastern(b.eventDate, to.h, to.m) : new Date(startAt.getTime() + 4 * 3_600_000);
  // An end before the start crosses midnight.
  if (endAt.getTime() <= startAt.getTime()) endAt = new Date(endAt.getTime() + 24 * 3_600_000);
  return { start: { dateTime: startAt.toISOString(), timeZone: TIME_ZONE }, end: { dateTime: endAt.toISOString(), timeZone: TIME_ZONE }, allDay: false };
}

const lastName = (full: string): string => {
  const parts = safeInline(full, 100).split(" ").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
};

const location = (b: Pick<BookingForCalendar, "venueName" | "address">): string => [safeInline(b.venueName, 160), safeInline(b.address, 200)].filter(Boolean).join(", ");

const itemsLine = (items: BookingForCalendar["items"]): string => items.map((i) => `${safeInline(i.name, 100)}${i.quantity > 1 ? ` x${i.quantity}` : ""}`).join(", ");

// GO's internal event: everything staff want at a glance. No attendees.
export function internalEventPayload(b: BookingForCalendar, company: CompanyForCalendar): EventPayload {
  const t = eventTimes(b);
  const type = safeInline(b.occasion, 80) || "Event";
  const lines = [
    `Items: ${itemsLine(b.items) || "none yet"}`,
    `Crew: ${b.crew.length > 0 ? b.crew.map((c) => `${safeInline(c.name, 100)} (${safeInline(c.role, 60)})`).join(", ") : "none assigned"}`,
    `On-site contact: ${[safeInline(b.onsiteContactName, 120), safeInline(b.onsiteContactPhone, 40)].filter(Boolean).join(" ") || "not set"}`,
    `Customer: ${safeInline(b.customerName, 100)}${b.phone ? ` ${safeInline(b.phone, 40)}` : ""}`,
    `Admin: ${company.adminUrl}/scheduling/bookings?booking=${b.id}`,
  ];
  return {
    summary: `${lastName(b.customerName) || "Booking"} - ${type}`,
    description: lines.join("\n").slice(0, 2000),
    location: location(b),
    start: t.start,
    end: t.end,
    visibility: "private",
    extendedProperties: { private: { goBookingId: b.id, goKind: "internal" } },
  };
}

// The customer's invite: only what a customer should see. No crew, no other
// phone than GO's, no notes, no admin link. The customer is the only guest
// and cannot invite others or see other guests.
export function inviteEventPayload(b: BookingForCalendar, company: CompanyForCalendar): EventPayload | null {
  const email = b.email?.trim();
  if (!email) return null;
  const t = eventTimes(b);
  const type = safeInline(b.occasion, 80) || "Event";
  const lines = [
    `Your ${type.toLowerCase() === "event" ? "event" : type} with ${company.name}.`,
    itemsLine(b.items) ? `Booked: ${itemsLine(b.items)}` : null,
    `Questions? Call or text ${company.phone}, or email ${company.email}.`,
    company.portalUrl ? `Your booking: ${company.portalUrl}` : null,
  ].filter((l): l is string => l !== null);
  return {
    summary: `${type} with ${company.name}`,
    description: lines.join("\n"),
    location: location(b),
    start: t.start,
    end: t.end,
    attendees: [{ email }],
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    guestsCanModify: false,
    extendedProperties: { private: { goBookingId: b.id, goKind: "invite" } },
  };
}

// A fingerprint of both payloads, so an unchanged booking is not re-sent.
export function syncHash(internal: EventPayload, invite: EventPayload | null): string {
  return createHash("sha256").update(JSON.stringify([internal, invite])).digest("hex").slice(0, 32);
}
