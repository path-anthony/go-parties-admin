import { isLostStage, isWonStage } from "../src/lib/leadStages.js";

// Block F3a. The Leads inbox: one list of everyone who might buy, wherever
// they came from. A row is a lead, or a storefront request that is waiting
// (it has no lead until staff turn it into a booking). Everything here is
// pure: the database is read in server/inboxLoad.ts and handed in, so the
// rules can be tested without one.
//
// Every lead sits in exactly one of four places, worked out from what is on
// the record, never stored:
//   new        nobody has contacted them yet
//   follow-up  contacted, still deciding
//   booked     has a booking that is going ahead (or was marked Booked)
//   lost       marked Lost, or every booking it had was cancelled
// "Storefront requests" and "Cancellation requests" are views across those.

export const INBOX_TABS = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "requests", label: "Storefront requests" },
  { key: "cancellations", label: "Cancellation requests" },
  { key: "follow-up", label: "Follow up" },
  { key: "booked", label: "Booked" },
  { key: "lost", label: "Lost" },
] as const;
export type InboxTab = (typeof INBOX_TABS)[number]["key"];
export const isInboxTab = (v: unknown): v is InboxTab => INBOX_TABS.some((t) => t.key === v);

// Where a lead came from, in words. "manual" was the only value for anything
// staff typed in before F3a; "phone" is the Add lead form since then.
export const SOURCE_WORDS: Record<string, string> = {
  website: "Website form",
  storefront: "Storefront",
  "ask-go": "Ask GO",
  concierge: "Talk to us",
  phone: "Phone or in person",
  manual: "Staff",
};
export const sourceWords = (source: string) => SOURCE_WORDS[source] ?? source;

export const LOST_REASONS = ["Price", "Date not available", "Booked someone else", "Outside our area", "No reply", "Event cancelled or changed", "Duplicate or test", "Other"] as const;
export const CONTACT_KINDS = ["call", "text", "email"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

// How long a contacted lead may sit with no next step before it is flagged.
export const NO_NEXT_STEP_DAYS = 3;

// ---- contact details -------------------------------------------------------------

// A lead's contact is one line of free text ("Jane, 860-555-0142,
// jane@x.com"). The email and the ten digit US phone in it, when there are any.
export function contactParts(text: string | null | undefined): { email: string | null; phone: string | null } {
  if (!text) return { email: null, phone: null };
  const email = text.match(/[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/)?.[0] ?? null;
  const rest = email ? text.replace(email, " ") : text;
  const digits = (rest.match(/\+?\d[\d\s().-]{8,}\d/)?.[0] ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return { email: email ? email.toLowerCase() : null, phone: ten.length === 10 ? ten : null };
}
const cleanEmail = (e: string | null | undefined) => (e && e.trim() !== "" ? e.trim().toLowerCase() : null);
const cleanPhone = (p: string | null | undefined) => contactParts(p ?? "").phone;
const cleanName = (n: string | null | undefined) => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// ---- the records as the inbox reads them -----------------------------------------

const DEAD = new Set(["Cancelled", "Released"]);

export type InboxBooking = {
  id: string;
  status: string;
  eventDate: Date;
  tier: number | null;
  retainerPaid: boolean;
  total: unknown;
  createdAt: Date;
  agreement: { contractStatus: string | null } | null;
  designRequest?: { id: string } | null;
  cancellationRequests: { id: string; status: string; createdAt: Date }[];
  itemNames: string[];
  packageName: string | null;
};

export type InboxLead = {
  id: string;
  status: string;
  source: string;
  customerName: string | null;
  contact: string | null;
  occasion: string | null;
  dateOfInterest: Date | null;
  notes: string | null;
  theme: string | null;
  itemsReturned: unknown;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  firstContactedAt: Date | null;
  lastContactedAt: Date | null;
  followUpOn: Date | null;
  followUpNote: string | null;
  lostReason: string | null;
  bookings: InboxBooking[];
};

export type InboxRequest = {
  id: string;
  status: string;
  customerName: string;
  phone: string | null;
  email: string | null;
  occasion: string | null;
  eventDate: Date;
  total: unknown;
  cart: unknown;
  createdAt: Date;
  dismissReason: string | null;
};

export type Bucket = "new" | "follow-up" | "booked" | "lost";
export type NextAction = { code: string; label: string; urgent: boolean };

export type InboxRow = {
  key: string;
  kind: "lead" | "request";
  id: string;
  tabs: InboxTab[];
  bucket: Bucket | "request";
  source: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactText: string | null;
  wants: string;
  eventDate: string | null;
  createdAt: string;
  ageDays: number;
  stage: string;
  nextAction: NextAction;
  followUpOn: string | null;
  bookingId: string | null;
  cancellationRequestId: string | null;
};

const dayText = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (fromDay: string, toDay: string) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function list(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 2) return unique.join(", ");
  return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}

// The column a lead that nobody has touched sits in: the one named "New",
// or the first column when there is none by that name.
export function newStageOf(columns: string[]): string | null {
  return columns.find((c) => c.trim().toLowerCase() === "new") ?? columns[0] ?? null;
}
export const stageNamed = (columns: string[], name: string): string | null => columns.find((c) => c.trim().toLowerCase() === name.toLowerCase()) ?? null;

export function bucketOf(lead: Pick<InboxLead, "status" | "firstContactedAt" | "bookings">, newStage: string | null): Bucket {
  const live = lead.bookings.filter((b) => !DEAD.has(b.status));
  if (live.length > 0) return "booked";
  if (isLostStage(lead.status) || lead.bookings.length > 0) return "lost";
  if (isWonStage(lead.status)) return "booked";
  if (lead.firstContactedAt === null && newStage !== null && lead.status === newStage) return "new";
  return "follow-up";
}

// The booking that matters now: the soonest one still going ahead.
const currentBooking = (lead: Pick<InboxLead, "bookings">) => [...lead.bookings].filter((b) => !DEAD.has(b.status)).sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime())[0] ?? null;
export const openCancellation = (lead: Pick<InboxLead, "bookings">) => lead.bookings.flatMap((b) => b.cancellationRequests.filter((c) => c.status === "Open").map((c) => ({ ...c, bookingId: b.id })))[0] ?? null;

// When the lead was last worked: a logged contact, or failing that any change.
const lastTouch = (lead: Pick<InboxLead, "lastContactedAt" | "updatedAt">) => lead.lastContactedAt ?? lead.updatedAt;

export function nextActionFor(lead: InboxLead, bucket: Bucket, today: string): NextAction {
  if (openCancellation(lead)) return { code: "cancellation", label: "Approve or decline the cancellation request", urgent: true };
  if (bucket === "booked") {
    const b = currentBooking(lead);
    if (!b) return { code: "booked", label: "Marked Booked. No booking is linked yet.", urgent: false };
    if (b.status === "Completed") return { code: "done", label: "Event done", urgent: false };
    if (b.tier === 2 && b.agreement?.contractStatus !== "Signed") return { code: "unsigned", label: "Waiting on the contract signature", urgent: false };
    if (!b.retainerPaid && b.total !== null && Number(b.total) > 0) return { code: "unpaid", label: "Waiting on the retainer", urgent: false };
    return { code: "booked", label: "Booked. Nothing to do.", urgent: false };
  }
  if (bucket === "lost") return { code: "lost", label: lead.bookings.length > 0 && !isLostStage(lead.status) ? "Booking cancelled" : `Closed${lead.lostReason ? `: ${lead.lostReason}` : ""}`, urgent: false };
  if (bucket === "new") return { code: "contact", label: "Contact them", urgent: true };
  if (lead.followUpOn) {
    const due = dayText(lead.followUpOn);
    const late = daysBetween(due, today);
    if (late > 0) return { code: "follow-up-late", label: `Follow up, ${plural(late, "day")} overdue`, urgent: true };
    if (late === 0) return { code: "follow-up-today", label: "Follow up today", urgent: true };
    return { code: "follow-up-later", label: `Follow up ${shortDay(due)}`, urgent: false };
  }
  const idle = daysBetween(dayText(lastTouch(lead)), today);
  if (idle >= NO_NEXT_STEP_DAYS) return { code: "no-next-step", label: `No next step for ${plural(idle, "day")}. Set one.`, urgent: true };
  return { code: "set-next-step", label: "Set the next step", urgent: false };
}

function leadWants(lead: InboxLead): string {
  const b = currentBooking(lead) ?? lead.bookings[0] ?? null;
  if (b) return b.packageName ?? (list(b.itemNames) || lead.occasion || "A booking");
  const picked = (lead.itemsReturned as { items?: { name?: unknown }[] } | null)?.items;
  if (Array.isArray(picked) && picked.length > 0) return list(picked.map((i) => (typeof i.name === "string" ? i.name : "")));
  const text = lead.occasion ?? lead.theme ?? lead.notes ?? "";
  return text.length > 90 ? `${text.slice(0, 87)}...` : text || "Not said yet";
}

function requestWants(r: InboxRequest): string {
  const cart = r.cart as { items?: { name?: unknown; quantity?: unknown }[]; package?: { name?: unknown } | null } | null;
  if (cart?.package && typeof cart.package.name === "string") return cart.package.name;
  const names = Array.isArray(cart?.items) ? cart.items.map((i) => (typeof i.name === "string" ? i.name : "")) : [];
  return list(names) || r.occasion || "A storefront order";
}

export function leadRow(lead: InboxLead, newStage: string | null, today: string): InboxRow {
  const bucket = bucketOf(lead, newStage);
  const parts = contactParts(lead.contact);
  const cancel = openCancellation(lead);
  const b = currentBooking(lead);
  const tabs: InboxTab[] = ["all", bucket];
  if (cancel) tabs.push("cancellations");
  // A lead whose booking came from a storefront request still reads as one.
  const fromRequest = lead.bookings.some((x) => x.designRequest);
  return {
    key: `lead:${lead.id}`,
    kind: "lead",
    id: lead.id,
    tabs,
    bucket,
    source: fromRequest && lead.source === "manual" ? "Storefront" : sourceWords(lead.source),
    name: lead.customerName?.trim() || "No name yet",
    phone: parts.phone,
    email: parts.email,
    contactText: lead.contact,
    wants: leadWants(lead),
    eventDate: b ? dayText(b.eventDate) : lead.dateOfInterest ? dayText(lead.dateOfInterest) : null,
    createdAt: lead.createdAt.toISOString(),
    ageDays: Math.max(0, daysBetween(dayText(lead.createdAt), today)),
    stage: lead.status,
    nextAction: nextActionFor(lead, bucket, today),
    followUpOn: lead.followUpOn ? dayText(lead.followUpOn) : null,
    bookingId: b?.id ?? lead.bookings[0]?.id ?? null,
    cancellationRequestId: cancel?.id ?? null,
  };
}

// A storefront request that has not become a booking. Open ones wait for
// staff; dismissed ones sit with the lost. A converted one is not a row: the
// booking made from it has a lead, and that lead is the row.
export function requestRow(r: InboxRequest, today: string): InboxRow | null {
  if (r.status === "Converted") return null;
  const open = r.status === "Open";
  return {
    key: `request:${r.id}`,
    kind: "request",
    id: r.id,
    tabs: open ? ["all", "requests"] : ["all", "lost"],
    bucket: "request",
    source: "Storefront",
    name: r.customerName.trim() || "No name yet",
    phone: cleanPhone(r.phone),
    email: cleanEmail(r.email),
    contactText: [r.phone, r.email].filter(Boolean).join(" · ") || null,
    wants: requestWants(r),
    eventDate: dayText(r.eventDate),
    createdAt: r.createdAt.toISOString(),
    ageDays: Math.max(0, daysBetween(dayText(r.createdAt), today)),
    stage: open ? "Storefront request" : "Dismissed",
    nextAction: open ? { code: "request", label: "Review it, then convert or dismiss", urgent: true } : { code: "dismissed", label: `Dismissed${r.dismissReason ? `: ${r.dismissReason}` : ""}`, urgent: false },
    followUpOn: null,
    bookingId: null,
    cancellationRequestId: null,
  };
}

// The whole inbox: what needs doing first, then newest first.
export function buildInbox(leads: InboxLead[], requests: InboxRequest[], columns: string[], today: string): { rows: InboxRow[]; counts: Record<InboxTab, number> } {
  const newStage = newStageOf(columns);
  const rows = [...leads.map((l) => leadRow(l, newStage, today)), ...requests.map((r) => requestRow(r, today)).filter((r): r is InboxRow => r !== null)];
  rows.sort((a, b) => Number(b.nextAction.urgent) - Number(a.nextAction.urgent) || b.createdAt.localeCompare(a.createdAt));
  const counts = Object.fromEntries(INBOX_TABS.map((t) => [t.key, rows.filter((r) => r.tabs.includes(t.key)).length])) as Record<InboxTab, number>;
  return { rows, counts };
}

// ---- linking a booking to the lead it came from ---------------------------------

export type MatchLead = Pick<InboxLead, "id" | "status" | "customerName" | "contact" | "createdAt"> & { bookings: { status: string }[] };
export type LeadMatch = { exact: MatchLead | null; near: MatchLead[] };

// How long ago a lead may have arrived and still be taken as the same sale.
export const MATCH_WINDOW_DAYS = 180;

// Which open lead a new storefront booking belongs to.
//
// Exact: the same email address (case ignored) or the same ten digit phone,
// on a lead that is still open: not Lost, no booking that is going ahead, and
// no older than MATCH_WINDOW_DAYS. With several, the newest. That lead is
// linked to the booking and moved to Booked.
//
// Near: the same name with a different or missing email and phone, or the
// same email or phone on a lead that is closed or already has a booking.
// Those are never linked on their own: the booking gets its own lead as
// before, and both are noted as a possible match for a person to judge.
export function matchLead(leads: MatchLead[], who: { name: string | null; email: string | null; phone: string | null }, now: Date): LeadMatch {
  const email = cleanEmail(who.email);
  const phone = cleanPhone(who.phone);
  const name = cleanName(who.name);
  const cutoff = now.getTime() - MATCH_WINDOW_DAYS * 86_400_000;
  const exact: MatchLead[] = [];
  const near: MatchLead[] = [];
  for (const lead of leads) {
    const parts = contactParts(lead.contact);
    const sameContact = (email !== null && parts.email === email) || (phone !== null && parts.phone === phone);
    const sameName = name !== "" && cleanName(lead.customerName) === name;
    if (!sameContact && !sameName) continue;
    const open = !isLostStage(lead.status) && !lead.bookings.some((b) => !DEAD.has(b.status)) && lead.createdAt.getTime() >= cutoff;
    if (sameContact && open) exact.push(lead);
    else near.push(lead);
  }
  const newest = (a: MatchLead, b: MatchLead) => b.createdAt.getTime() - a.createdAt.getTime();
  exact.sort(newest);
  near.sort(newest);
  return { exact: exact[0] ?? null, near: [...exact.slice(1), ...near].slice(0, 5) };
}
