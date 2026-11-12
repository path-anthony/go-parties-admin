import { itemsBrief, type ItemLine } from "./bookingItems.js";
import type { PolicyState } from "./policyAccept.js";

// Block F3b. The Bookings list: which view a booking is in, the one status
// staff read, and why it needs action. Pure: server/bookingsLoad.ts reads the
// database and hands the facts in. Nothing here is stored, and nothing here
// changes when a booking is Confirmed or what is owed; the amounts are the
// ones amountsFor and owedStep worked out.

export const BOOKING_VIEWS = [
  { key: "needs-action", label: "Needs action", help: "Bookings that are waiting on something: a signature, the policy, a payment, a decision, wedding details or crew. Each row says which." },
  { key: "upcoming", label: "Upcoming", help: "Every booking that is going ahead, soonest first." },
  { key: "past", label: "Past", help: "Events that have happened, newest first." },
  { key: "cancelled", label: "Cancelled", help: "Bookings that were cancelled, and unpaid holds that were released." },
] as const;
export type BookingView = (typeof BOOKING_VIEWS)[number]["key"];
export const isBookingView = (v: unknown): v is BookingView => BOOKING_VIEWS.some((t) => t.key === v);

// The one status a row shows, in words.
export const STATUS_WORDS = ["Awaiting contract", "Awaiting retainer", "Confirmed", "Balance due", "Cancellation requested", "Cancelled", "Done"] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

export const BALANCE_SOON_DAYS = 14;
export const WEDDING_DETAILS_DAYS = 45;
export const CREW_DAYS = 7;

export type BookingFacts = {
  id: string;
  leadId: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  eventDate: string;
  eventTime: string | null;
  occasion: string | null;
  // The stored stage: Held, Contract Sent, Signed, Completed, Cancelled, Released.
  stage: string;
  rush: boolean;
  totalCents: number | null;
  paidCents: number;
  // The contract path, not signed yet.
  needsSignature: boolean;
  contractSentAt: string | null;
  retainerPaid: boolean;
  retainerOwedCents: number | null;
  balanceOwedCents: number | null;
  balanceDueDate: string | null;
  payLinkSentAt: string | null;
  cancellationRequested: boolean;
  policy: PolicyState;
  // A wedding booking whose details form is not submitted.
  weddingDetailsMissing: boolean;
  // Gigs on the booking that are not cancelled, and how many have nobody yet.
  crewNeeded: number;
  crewUnassigned: number;
  items: ItemLine[];
  packageName: string | null;
};

export type Need = { code: "cancellation" | "unsigned" | "policy" | "retainer" | "balance-overdue" | "wedding-details" | "crew"; label: string };
export type BookingAction = { code: "decide-cancellation" | "send-contract" | "send-pay-link" | "wedding-details" | "assign-crew" | "none"; label: string };

export type BookingRow = {
  id: string;
  leadId: string | null;
  views: BookingView[];
  eventDate: string;
  eventTime: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  occasion: string | null;
  items: string;
  total: number | null;
  status: StatusWord;
  needs: Need[];
  nextAction: BookingAction;
  rush: boolean;
};

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const cancelled = (f: BookingFacts) => f.stage === "Cancelled" || f.stage === "Released";
const over = (f: BookingFacts) => cancelled(f) || f.stage === "Completed";

// Why a booking needs action, most pressing first. A cancelled or finished
// booking needs nothing. A balance that is overdue and a cancellation request
// count whenever they exist; the rest only while the event is still ahead.
export function needsActionFor(f: BookingFacts, today: string): Need[] {
  if (over(f)) return [];
  const ahead = f.eventDate >= today;
  const needs: Need[] = [];
  if (f.cancellationRequested) needs.push({ code: "cancellation", label: "Cancellation requested" });
  if (ahead && f.needsSignature) needs.push({ code: "unsigned", label: f.contractSentAt ? "Contract unsigned" : "Contract not sent" });
  if (ahead && f.policy.needed && f.policy.by === "nobody") needs.push({ code: "policy", label: "Policy not accepted" });
  if (ahead && !f.needsSignature && (f.retainerOwedCents ?? 0) > 0) needs.push({ code: "retainer", label: `Retainer unpaid, ${usd(f.retainerOwedCents ?? 0)}` });
  if ((f.balanceOwedCents ?? 0) > 0 && f.balanceDueDate !== null && f.balanceDueDate < today) needs.push({ code: "balance-overdue", label: `Balance overdue, ${usd(f.balanceOwedCents ?? 0)} was due ${short(f.balanceDueDate)}` });
  if (ahead && f.weddingDetailsMissing && f.eventDate <= addDays(today, WEDDING_DETAILS_DAYS)) needs.push({ code: "wedding-details", label: "Wedding details missing" });
  if (ahead && f.crewUnassigned > 0 && f.eventDate <= addDays(today, CREW_DAYS)) needs.push({ code: "crew", label: f.crewUnassigned === f.crewNeeded ? "No crew assigned" : `${f.crewUnassigned} of ${f.crewNeeded} crew spots open` });
  return needs;
}

// The one status in words. Balance due shows once the balance is within 14
// days of its due day or past it; before that a paid-up booking is Confirmed.
export function statusWord(f: BookingFacts, today: string): StatusWord {
  if (cancelled(f)) return "Cancelled";
  if (f.cancellationRequested) return "Cancellation requested";
  if (f.stage === "Completed") return "Done";
  const balanceOwed = (f.balanceOwedCents ?? 0) > 0;
  if (f.eventDate < today) return balanceOwed ? "Balance due" : "Done";
  if (f.needsSignature) return "Awaiting contract";
  if ((f.retainerOwedCents ?? 0) > 0 || !f.retainerPaid) return "Awaiting retainer";
  if (balanceOwed && f.balanceDueDate !== null && f.balanceDueDate <= addDays(today, BALANCE_SOON_DAYS)) return "Balance due";
  return "Confirmed";
}

export function viewsOf(f: BookingFacts, today: string): BookingView[] {
  if (cancelled(f)) return ["cancelled"];
  const base: BookingView = f.stage === "Completed" || f.eventDate < today ? "past" : "upcoming";
  return needsActionFor(f, today).length > 0 ? ["needs-action", base] : [base];
}

// The one main button on the booking popup, from the first thing it needs.
export function nextBookingAction(f: BookingFacts, today: string): BookingAction {
  const first = needsActionFor(f, today)[0];
  if (!first) {
    if (!over(f) && (f.balanceOwedCents ?? 0) > 0 && f.retainerPaid) return { code: "send-pay-link", label: "Send pay link" };
    return { code: "none", label: cancelled(f) ? "Nothing to do. This booking is cancelled." : f.stage === "Completed" || f.eventDate < today ? "Nothing to do. The event is done." : "Nothing to do right now." };
  }
  if (first.code === "cancellation") return { code: "decide-cancellation", label: "Decide the cancellation request" };
  if (first.code === "unsigned") return { code: "send-contract", label: "Send contract link" };
  if (first.code === "policy" || first.code === "retainer" || first.code === "balance-overdue") return { code: "send-pay-link", label: "Send pay link" };
  if (first.code === "wedding-details") return { code: "wedding-details", label: "Open wedding details" };
  return { code: "assign-crew", label: "Assign crew" };
}

export function bookingRow(f: BookingFacts, today: string): BookingRow {
  return {
    id: f.id,
    leadId: f.leadId,
    views: viewsOf(f, today),
    eventDate: f.eventDate,
    eventTime: f.eventTime,
    customerName: f.customerName,
    email: f.email,
    phone: f.phone,
    occasion: f.occasion,
    items: itemsBrief(f.items, f.packageName),
    total: f.totalCents === null ? null : f.totalCents / 100,
    status: statusWord(f, today),
    needs: needsActionFor(f, today),
    nextAction: nextBookingAction(f, today),
    rush: f.rush && !cancelled(f),
  };
}

// The whole list, soonest event first (the screen turns Past and Cancelled
// round to newest first).
export function buildBookingsList(facts: BookingFacts[], today: string): { rows: BookingRow[]; counts: Record<BookingView, number> } {
  const rows = facts.map((f) => bookingRow(f, today)).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const counts = Object.fromEntries(BOOKING_VIEWS.map((v) => [v.key, rows.filter((r) => r.views.includes(v.key)).length])) as Record<BookingView, number>;
  return { rows, counts };
}

// Search by name, email or phone (digits only), and the two filters.
export function filterRows(rows: BookingRow[], f: { q?: string; from?: string; to?: string; status?: string }): BookingRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows.filter((r) => {
    if (f.from && r.eventDate < f.from) return false;
    if (f.to && r.eventDate > f.to) return false;
    if (f.status && r.status !== f.status) return false;
    if (q === "") return true;
    if (r.customerName.toLowerCase().includes(q) || (r.email ?? "").toLowerCase().includes(q)) return true;
    return digits.length >= 3 && (r.phone ?? "").replace(/\D/g, "").includes(digits);
  });
}
