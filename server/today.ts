import type { InboxRow } from "./inbox.js";

// Block F3a. The Today view: what needs doing, in three columns of work.
// Pure: server/inboxLoad.ts reads the database and hands the facts in.
//
//   Close the sale   new leads nobody has contacted, storefront requests
//                    waiting, contracts unsigned, retainers unpaid
//   Nurture          follow ups due today or overdue, contacted leads with no
//                    next step for 3 days
//   After the sale   cancellation requests, balances due within 14 days,
//                    wedding details missing within 45 days, events in the
//                    next 7 days
//
// Every item is one line and opens the lead or the booking it is about.

export const BALANCE_SOON_DAYS = 14;
export const WEDDING_DETAILS_DAYS = 45;
export const EVENTS_AHEAD_DAYS = 7;

// A booking that is going ahead, with what is still open on it. The amounts
// come from amountsFor and owedStep (Block F1); nothing is recalculated here.
export type TodayBooking = {
  id: string;
  leadId: string | null;
  customerName: string;
  eventDate: string;
  eventTime: string | null;
  stage: string;
  needsSignature: boolean;
  contractSentAt: string | null;
  retainerOwedCents: number | null;
  payLinkSentAt: string | null;
  balanceOwedCents: number | null;
  balanceDueDate: string | null;
  // A wedding booking whose details form is not submitted.
  weddingDetailsMissing: boolean;
};

export type TodayItem = { key: string; open: { kind: "lead" | "request" | "booking"; id: string }; title: string; detail: string; button: string };
export type TodayGroup = { key: string; label: string; items: TodayItem[] };
export type TodayColumn = { key: "close" | "nurture" | "after"; label: string; help: string; empty: string; count: number; groups: TodayGroup[] };

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const short = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const age = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);
const daysUntil = (today: string, day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

const rowOpen = (r: InboxRow): TodayItem["open"] => ({ kind: r.kind, id: r.id });
const who = (r: InboxRow) => `${r.name} · ${r.source}`;
const what = (r: InboxRow) => [r.wants, r.eventDate ? `event ${short(r.eventDate)}` : null].filter(Boolean).join(" · ");

export function buildToday(rows: InboxRow[], bookings: TodayBooking[], today: string): TodayColumn[] {
  const oldestFirst = (a: InboxRow, b: InboxRow) => a.createdAt.localeCompare(b.createdAt);
  const byEvent = (a: TodayBooking, b: TodayBooking) => a.eventDate.localeCompare(b.eventDate);
  const bookingItem = (b: TodayBooking, key: string, detail: string, button: string): TodayItem => ({ key: `${key}:${b.id}`, open: { kind: "booking", id: b.id }, title: `${b.customerName} · event ${short(b.eventDate)}`, detail, button });

  // ---- Close the sale
  const fresh = rows.filter((r) => r.kind === "lead" && r.bucket === "new").sort(oldestFirst);
  const requests = rows.filter((r) => r.tabs.includes("requests")).sort(oldestFirst);
  const unsigned = bookings.filter((b) => b.needsSignature).sort(byEvent);
  const unpaid = bookings.filter((b) => !b.needsSignature && (b.retainerOwedCents ?? 0) > 0).sort(byEvent);
  const close: TodayGroup[] = [
    { key: "new-leads", label: "New leads, not contacted", items: fresh.map((r) => ({ key: r.key, open: rowOpen(r), title: who(r), detail: `${what(r)} · arrived ${age(r.ageDays)}`, button: "Contact" })) },
    { key: "requests", label: "Storefront requests waiting", items: requests.map((r) => ({ key: r.key, open: rowOpen(r), title: who(r), detail: `${what(r)} · sent ${age(r.ageDays)}`, button: "Review" })) },
    {
      key: "unsigned",
      label: "Contracts unsigned",
      items: unsigned.map((b) => bookingItem(b, "unsigned", b.contractSentAt ? `Contract sent ${short(b.contractSentAt)}, not signed${b.retainerOwedCents ? `. Retainer ${usd(b.retainerOwedCents)} follows.` : "."}` : "The contract has not been sent yet.", b.contractSentAt ? "Open" : "Send it")),
    },
    {
      key: "unpaid",
      label: "Retainers unpaid",
      items: unpaid.map((b) => bookingItem(b, "unpaid", `Retainer ${usd(b.retainerOwedCents ?? 0)} · ${b.payLinkSentAt ? `pay link sent ${short(b.payLinkSentAt)}` : "pay link not sent"}`, b.payLinkSentAt ? "Open" : "Send pay link")),
    },
  ];

  // ---- Nurture
  const due = rows.filter((r) => r.nextAction.code === "follow-up-late" || r.nextAction.code === "follow-up-today").sort((a, b) => (a.followUpOn ?? "").localeCompare(b.followUpOn ?? ""));
  const idle = rows.filter((r) => r.nextAction.code === "no-next-step").sort(oldestFirst);
  const nurture: TodayGroup[] = [
    { key: "follow-ups", label: "Follow ups due today or overdue", items: due.map((r) => ({ key: r.key, open: rowOpen(r), title: who(r), detail: `${r.nextAction.label} · ${what(r)}`, button: "Follow up" })) },
    { key: "no-next-step", label: "Contacted, no next step for 3 days", items: idle.map((r) => ({ key: r.key, open: rowOpen(r), title: who(r), detail: `${r.nextAction.label} ${what(r)}`, button: "Set next step" })) },
  ];

  // ---- After the sale
  const cancels = rows.filter((r) => r.tabs.includes("cancellations")).sort(oldestFirst);
  const soon = addDays(today, BALANCE_SOON_DAYS);
  const balances = bookings.filter((b) => (b.balanceOwedCents ?? 0) > 0 && b.balanceDueDate !== null && b.balanceDueDate <= soon).sort((a, b) => (a.balanceDueDate ?? "").localeCompare(b.balanceDueDate ?? ""));
  const weddingBy = addDays(today, WEDDING_DETAILS_DAYS);
  const weddings = bookings.filter((b) => b.weddingDetailsMissing && b.eventDate <= weddingBy).sort(byEvent);
  const eventsBy = addDays(today, EVENTS_AHEAD_DAYS);
  const events = bookings.filter((b) => b.eventDate >= today && b.eventDate <= eventsBy).sort(byEvent);
  const after: TodayGroup[] = [
    { key: "cancellations", label: "Cancellation requests", items: cancels.map((r) => ({ key: `cancel:${r.id}`, open: rowOpen(r), title: who(r), detail: `Asked to cancel · ${what(r)}. The booking is still held.`, button: "Decide" })) },
    {
      key: "balances",
      label: `Balances due within ${BALANCE_SOON_DAYS} days`,
      items: balances.map((b) => bookingItem(b, "balance", `Balance ${usd(b.balanceOwedCents ?? 0)} · ${(b.balanceDueDate as string) < today ? `was due ${short(b.balanceDueDate as string)}` : `due ${short(b.balanceDueDate as string)}`}`, "Open")),
    },
    { key: "wedding-details", label: `Wedding details missing, event within ${WEDDING_DETAILS_DAYS} days`, items: weddings.map((b) => bookingItem(b, "wedding", `The wedding details form is not submitted. The event is ${inDays(daysUntil(today, b.eventDate))}.`, "Open")) },
    { key: "events", label: `Events in the next ${EVENTS_AHEAD_DAYS} days`, items: events.map((b) => bookingItem(b, "event", `${inDays(daysUntil(today, b.eventDate)).replace(/^./, (c) => c.toUpperCase())}${b.eventTime ? `, ${b.eventTime}` : ""} · ${b.stage}`, "Open")) },
  ];

  const column = (key: TodayColumn["key"], label: string, help: string, empty: string, groups: TodayGroup[]): TodayColumn => ({ key, label, help, empty, count: groups.reduce((n, g) => n + g.items.length, 0), groups });
  return [
    column("close", "Close the sale", "People who want to buy and are waiting on you or on a signature or payment. Work these first.", "Nothing is waiting to be closed. Every lead has been contacted and nothing is unsigned or unpaid.", close),
    column("nurture", "Nurture", "People you have spoken to who have not decided. Each one needs a next step with a date.", "No follow ups are due. Everyone you are talking to has a next step.", nurture),
    column("after", "After the sale", "Bookings that need something from you before the event.", "Nothing needs attention on your bookings this week.", after),
  ];
}
