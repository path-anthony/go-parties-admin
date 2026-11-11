import { getDefaultAccount } from "./account.js";
import { addDays, atEastern, easternDay, humanDay } from "./automation/time.js";
import { DIGEST_HOUR } from "./automation/planner.js";
import { adminBase } from "./bids.js";
import { prisma } from "./db.js";
import { safeErr } from "./log.js";
import { amountsFor } from "./payments.js";
import { safeInline } from "./sanitize.js";
import { getSettings } from "./settings.js";
import { dueDateFor, isWeddingBooking } from "./weddingDetails/logic.js";

// Staff notifications: the bell in the admin and the morning digest. Each
// condition has a dedupeKey, and the unique index on it is what makes a
// condition fire once however many passes see it. New leads fire as they
// happen; everything timed is worked out by runTimedNotifications, which
// the hourly scheduler calls on real runs only.

export const NOTIFICATION_TYPES = [
  { type: "new-lead", label: "New leads" },
  { type: "design-request", label: "Requests for review" },
  { type: "design-request-overdue", label: "Requests waiting too long" },
  { type: "contract-unsigned-3d", label: "Needs a push to sign" },
  { type: "payment-received", label: "Payments received" },
  { type: "cancellation-request", label: "Cancellation requests" },
  { type: "retainer-unpaid-3d", label: "Retainer unpaid" },
  { type: "retainer-still-unpaid", label: "Retainer still unpaid" },
  { type: "balance-due-7d", label: "Balance due soon" },
  { type: "wedding-details-not-started-60d", label: "Wedding details not started" },
  { type: "wedding-details-incomplete-35d", label: "Wedding details incomplete" },
  { type: "wedding-details-submitted", label: "Wedding details submitted" },
  { type: "wedding-details-change-request", label: "Wedding details change requests" },
  { type: "content-creation-interest", label: "Upsell: content creation" },
  { type: "address-checks-paused", label: "Address checks paused" },
  { type: "address-not-checked", label: "Address not checked" },
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]["type"];
export const isNotificationType = (v: unknown): v is NotificationType => NOTIFICATION_TYPES.some((t) => t.type === v);

export type NotificationInput = {
  accountId: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  bookingId?: string | null;
  leadId?: string | null;
  customerId?: string | null;
  dedupeKey: string;
};

const DAY_MS = 86_400_000;
const WAIT_DAYS = 3;
const WEDDING_NOT_STARTED_DAYS = 60;
const WEDDING_INCOMPLETE_DAYS = 35;
// Stages where a booking is still going ahead (Completed, Cancelled and
// Released are not).
const LIVE_STAGES = ["Held", "Contract Sent", "Signed"];

export const bookingLink = (id: string) => `/scheduling/bookings?booking=${id}`;
export const leadLink = (id: string) => `/leads?lead=${id}`;
const clean = (text: string | null | undefined, fallback: string) => safeInline(text ?? "", 100) || fallback;
// An event date is a calendar day stored at UTC midnight; noon Eastern reads
// back as that same day.
const dayLabel = (day: string) => humanDay(atEastern(day, 12));
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

// Inserts what is new and ignores what has already fired. Returns how many
// rows were really added.
export async function createNotifications(rows: NotificationInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { count } = await prisma.notification.createMany({ data: rows, skipDuplicates: true });
  return count;
}

// ---- Event producers ----------------------------------------------------

const SOURCE_WORD: Record<string, string> = { website: "Website inquiry", concierge: "Concierge request", storefront: "Storefront booking", "ask-go": "Ask GO chat" };

// A lead just arrived from outside (the website form through n8n, a concierge
// request, a storefront hold). Never throws: a notification must not be able
// to fail the request that made the lead.
export async function notifyNewLead(lead: { id: string; accountId: string; source: string; customerName?: string | null; occasion?: string | null; bookingId?: string | null; customerId?: string | null }): Promise<void> {
  try {
    const who = clean(lead.customerName, "No name yet");
    const about = lead.occasion ? safeInline(lead.occasion, 80) : "";
    await createNotifications([
      {
        accountId: lead.accountId,
        type: "new-lead",
        title: "New lead",
        body: `${who}. ${SOURCE_WORD[lead.source] ?? lead.source}${about ? `: ${about}` : ""}.`,
        link: leadLink(lead.id),
        leadId: lead.id,
        bookingId: lead.bookingId ?? null,
        customerId: lead.customerId ?? null,
        dedupeKey: `new-lead:${lead.id}`,
      },
    ]);
  } catch (err) {
    console.warn("[notifications] new lead not recorded:", safeErr(err));
  }
}

// A tier 3 request just went to Design Requests. Nothing is held and no
// booking exists until staff convert it, so the link is the Open list.
// Never throws, for the same reason as a new lead.
export async function notifyDesignRequest(request: { id: string; accountId: string; customerName: string; eventDate: Date; total: unknown; occasion: string | null; customerId: string | null }): Promise<void> {
  try {
    const total = request.total === null || request.total === undefined ? "" : ` ${usd(Math.round(Number(request.total) * 100))}.`;
    const about = request.occasion ? ` ${safeInline(request.occasion, 80)}.` : "";
    await createNotifications([
      {
        accountId: request.accountId,
        type: "design-request",
        title: "Request for review",
        body: `${clean(request.customerName, "Customer")}, ${dayLabel(dayOf(request.eventDate))}.${about}${total}`,
        link: "/design-requests?status=Open",
        customerId: request.customerId,
        dedupeKey: `design-request:${request.id}`,
      },
    ]);
  } catch (err) {
    console.warn("[notifications] design request not recorded:", safeErr(err));
  }
}

// Block F1. Money arrived: a card payment Stripe confirmed, or one staff
// recorded by hand. One alert per payment (the payment id is the key), so the
// same Stripe event twice still says it once. Never throws.
export async function notifyPaymentReceived(paymentId: string): Promise<void> {
  try {
    const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true, accountId: true, kind: true, amountCents: true, method: true, booking: { select: { id: true, customerName: true, eventDate: true, leadId: true, customerId: true } } } });
    if (!p) return;
    const what = p.kind === "retainer" ? "retainer" : p.kind === "balance" ? "balance" : "payment";
    const how = p.method === "card" ? "by card" : `by ${p.method}, recorded by staff`;
    await createNotifications([
      {
        accountId: p.accountId,
        type: "payment-received",
        title: "Payment received",
        body: `${clean(p.booking.customerName, "Customer")}, ${dayLabel(dayOf(p.booking.eventDate))}. ${usd(p.amountCents)} ${what}, ${how}.`,
        link: bookingLink(p.booking.id),
        bookingId: p.booking.id,
        leadId: p.booking.leadId,
        customerId: p.booking.customerId,
        dedupeKey: `payment-received:${p.id}`,
      },
    ]);
  } catch (err) {
    console.warn("[notifications] payment not recorded:", safeErr(err));
  }
}

// Block F1. A customer asked to cancel. Nothing is cancelled until staff
// decide, so this is the alert that makes someone look. Never throws.
export async function notifyCancellationRequest(request: { id: string; accountId: string; paidCents: number; booking: { id: string; customerName: string; eventDate: Date; leadId: string | null; customerId: string | null } }): Promise<void> {
  try {
    await createNotifications([
      {
        accountId: request.accountId,
        type: "cancellation-request",
        title: "Cancellation request",
        body: `${clean(request.booking.customerName, "Customer")}, ${dayLabel(dayOf(request.booking.eventDate))}. ${request.paidCents > 0 ? `${usd(request.paidCents)} paid so far.` : "Nothing paid yet."} The booking is still held until you decide.`,
        link: request.booking.leadId ? leadLink(request.booking.leadId) : bookingLink(request.booking.id),
        bookingId: request.booking.id,
        leadId: request.booking.leadId,
        customerId: request.booking.customerId,
        dedupeKey: `cancellation-request:${request.id}`,
      },
    ]);
  } catch (err) {
    console.warn("[notifications] cancellation request not recorded:", safeErr(err));
  }
}

// Staff decided a cancellation request: its alert is settled.
export async function clearCancellationAlert(requestId: string, now = new Date()): Promise<void> {
  await prisma.notification.updateMany({ where: { readAt: null, dedupeKey: `cancellation-request:${requestId}` }, data: { readAt: now } }).catch(() => undefined);
}

// The last retainer reminder day that is switched on, or null when all are off.
export function lastRetainerReminderDay(settings: { retainerReminderDay1: number; retainerReminderDay2: number; retainerReminderDay3: number }): number | null {
  const on = [settings.retainerReminderDay1, settings.retainerReminderDay2, settings.retainerReminderDay3].filter((d) => d > 0);
  return on.length === 0 ? null : Math.max(...on);
}

// ---- Timed producers ----------------------------------------------------

// Everything that should have fired by `now`. Reads only, so it can be run
// to see what a first pass would create.
export async function findDueNotifications(now: Date): Promise<NotificationInput[]> {
  const account = await getDefaultAccount();
  const accountId = account.id;
  const settings = await getSettings(accountId);
  const todayText = easternDay(now);
  const today = new Date(`${todayText}T00:00:00Z`);
  const cutoff = new Date(now.getTime() - WAIT_DAYS * DAY_MS);
  const out: NotificationInput[] = [];

  // A contract sent, or a tier 2 hold made, and no signature after 3 days.
  // A booking staff moved to Signed by hand (a paper contract) is out.
  const unsigned = await prisma.agreement.findMany({
    where: {
      accountId,
      contractStatus: "Sent",
      contractSentAt: { lte: cutoff },
      OR: [{ booking: { is: { status: { in: ["Held", "Contract Sent"] }, eventDate: { gte: today } } } }, { designRequest: { is: { status: "Open", eventDate: { gte: today } } } }],
    },
    select: { id: true, contractSentAt: true, customerId: true, booking: { select: { id: true, customerName: true, eventDate: true, leadId: true } }, designRequest: { select: { id: true, customerName: true, eventDate: true } } },
  });
  for (const a of unsigned) {
    const rec = a.booking ?? a.designRequest;
    if (!rec) continue;
    const sent = humanDay(a.contractSentAt as Date);
    out.push({
      accountId,
      type: "contract-unsigned-3d",
      title: "Needs a push to sign",
      body: `${clean(rec.customerName, "Customer")}, ${dayLabel(dayOf(rec.eventDate))}. Contract sent ${sent}, not signed.`,
      link: a.booking ? bookingLink(a.booking.id) : "/design-requests",
      bookingId: a.booking?.id ?? null,
      leadId: a.booking?.leadId ?? null,
      customerId: a.customerId,
      dedupeKey: `contract-unsigned-3d:${a.id}`,
    });
  }

  // Signed, retainer still unpaid 3 days later.
  const signedUnpaid = await prisma.agreement.findMany({
    where: { accountId, contractStatus: "Signed", contractDocument: { is: { signedAt: { lte: cutoff } } }, booking: { is: { retainerPaid: false, status: { in: LIVE_STAGES }, eventDate: { gte: today } } } },
    select: { contractDocument: { select: { signedAt: true } }, customerId: true, booking: { select: { id: true, customerName: true, eventDate: true, leadId: true } } },
  });
  for (const a of signedUnpaid) {
    if (!a.booking || !a.contractDocument) continue;
    out.push({
      accountId,
      type: "retainer-unpaid-3d",
      title: "Retainer unpaid",
      body: `${clean(a.booking.customerName, "Customer")}, ${dayLabel(dayOf(a.booking.eventDate))}. Signed ${humanDay(a.contractDocument.signedAt)}, retainer not paid.`,
      link: bookingLink(a.booking.id),
      bookingId: a.booking.id,
      leadId: a.booking.leadId,
      customerId: a.customerId,
      dedupeKey: `retainer-unpaid-3d:${a.booking.id}`,
    });
  }

  // The balance falls due within the balance reminder window (Settings,
  // 7 days unless changed) or already has, and is still open. Keyed by the
  // due day, so moving the event raises it again.
  const lastEvent = new Date(`${addDays(todayText, settings.balanceDueDays + settings.balanceReminderWindowDays)}T00:00:00Z`);
  const openBalances = await prisma.booking.findMany({
    where: { accountId, status: { in: LIVE_STAGES }, balancePaid: false, total: { not: null }, eventDate: { gte: today, lte: lastEvent } },
    include: { agreement: { select: { contractStatus: true, contractDocument: { select: { documentJson: true } } } }, payments: true },
  });
  for (const b of openBalances) {
    const money = amountsFor(b, b.payments, settings);
    if (money.balancePaid || !money.balanceDueCents) continue;
    const eventDay = dayOf(b.eventDate);
    const dueDay = addDays(eventDay, -settings.balanceDueDays);
    out.push({
      accountId,
      type: "balance-due-7d",
      title: "Balance due soon",
      body: `${clean(b.customerName, "Customer")}, ${dayLabel(eventDay)}. ${usd(money.balanceDueCents)} ${dueDay < todayText ? "was due" : "due"} ${dayLabel(dueDay)}.`,
      link: bookingLink(b.id),
      bookingId: b.id,
      leadId: b.leadId,
      customerId: b.customerId,
      dedupeKey: `balance-due-7d:${b.id}:${dueDay}`,
    });
  }

  // Wedding details: nothing started by 60 days out, not submitted by 35.
  const lastWedding = new Date(`${addDays(todayText, WEDDING_NOT_STARTED_DAYS)}T00:00:00Z`);
  const weddings = await prisma.booking.findMany({
    where: { accountId, status: { in: LIVE_STAGES }, eventDate: { gte: today, lte: lastWedding } },
    select: { id: true, customerName: true, eventDate: true, occasion: true, weddingOverride: true, leadId: true, customerId: true, package: { select: { occasions: true } }, weddingDetails: { select: { status: true } } },
  });
  for (const b of weddings) {
    if (!isWeddingBooking(b)) continue;
    const eventDay = dayOf(b.eventDate);
    const status = b.weddingDetails?.status ?? "not_started";
    const daysOut = Math.round((b.eventDate.getTime() - today.getTime()) / DAY_MS);
    const base = { accountId, link: bookingLink(b.id), bookingId: b.id, leadId: b.leadId, customerId: b.customerId };
    const who = `${clean(b.customerName, "Customer")}, ${dayLabel(eventDay)}.`;
    const due = `Due ${dayLabel(dueDateFor(eventDay))}.`;
    if (status === "not_started") out.push({ ...base, type: "wedding-details-not-started-60d", title: "Wedding details not started", body: `${who} ${daysOut} days out, not started. ${due}`, dedupeKey: `wedding-details-not-started-60d:${b.id}:${eventDay}` });
    if (status !== "submitted" && daysOut <= WEDDING_INCOMPLETE_DAYS) out.push({ ...base, type: "wedding-details-incomplete-35d", title: "Wedding details incomplete", body: `${who} ${daysOut} days out, not submitted. ${due}`, dedupeKey: `wedding-details-incomplete-35d:${b.id}:${eventDay}` });
  }
  // Block F2: a request still open after the promised number of business
  // days. One alert per day (the day is in the key) until it is converted or
  // dismissed, so it shows in the bell and in each morning's digest.
  const waiting = await prisma.designRequest.findMany({
    where: { accountId, status: "Open" },
    select: { id: true, customerName: true, eventDate: true, createdAt: true, customerId: true, total: true },
  });
  // Block F1: asked for the retainer, every reminder has gone, still unpaid.
  // Fires once per booking, the day after the last reminder was due. A
  // contract booking that is not signed yet is waiting on the signature, and
  // the unsigned-contract alert covers it.
  const lastDay = lastRetainerReminderDay(settings);
  if (lastDay !== null) {
    const asked = await prisma.booking.findMany({
      where: { accountId, retainerRequestedAt: { not: null }, retainerPaid: false, status: { in: LIVE_STAGES }, eventDate: { gte: today } },
      select: { id: true, customerName: true, eventDate: true, leadId: true, customerId: true, tier: true, retainerRequestedAt: true, agreement: { select: { contractStatus: true } } },
    });
    for (const b of asked) {
      if (!b.retainerRequestedAt || (b.tier === 2 && b.agreement?.contractStatus !== "Signed")) continue;
      const askedDay = easternDay(b.retainerRequestedAt);
      if (now < atEastern(addDays(askedDay, lastDay + 1), 10)) continue;
      out.push({
        accountId,
        type: "retainer-still-unpaid",
        title: "Retainer still unpaid",
        body: `${clean(b.customerName, "Customer")}, ${dayLabel(dayOf(b.eventDate))}. Asked ${humanDay(b.retainerRequestedAt)}, every reminder has gone, still not paid.`,
        link: bookingLink(b.id),
        bookingId: b.id,
        leadId: b.leadId,
        customerId: b.customerId,
        dedupeKey: `retainer-still-unpaid:${b.id}`,
      });
    }
  }

  for (const r of waiting) {
    const open = businessDaysBetween(easternDay(r.createdAt), todayText);
    if (open < settings.requestResponseDays) continue;
    out.push({
      accountId,
      type: "design-request-overdue",
      title: "Request still waiting",
      body: `${clean(r.customerName, "Customer")}, ${dayLabel(dayOf(r.eventDate))}. Open ${open} business ${open === 1 ? "day" : "days"}; the customer was told ${settings.requestResponseDays}.`,
      link: "/design-requests?status=Open",
      customerId: r.customerId,
      dedupeKey: `design-request-overdue:${r.id}:${todayText}`,
    });
  }

  return out;
}

// Block F2: whole business days (Monday to Friday) from one Eastern day to a
// later one. The starting day itself does not count.
export function businessDaysBetween(fromDay: string, toDay: string): number {
  let n = 0;
  for (let d = addDays(fromDay, 1); d <= toDay; d = addDays(d, 1)) {
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) n += 1;
  }
  return n;
}

// Block F2: a request was turned into a booking or dismissed, so its alerts
// (the first one and every "still waiting" one) are done. Never throws.
export async function clearRequestAlerts(requestId: string, now = new Date()): Promise<number> {
  try {
    const { count } = await prisma.notification.updateMany({
      where: { readAt: null, OR: [{ dedupeKey: `design-request:${requestId}` }, { dedupeKey: { startsWith: `design-request-overdue:${requestId}:` } }] },
      data: { readAt: now },
    });
    return count;
  } catch (err) {
    console.warn("[notifications] request alerts not cleared:", safeErr(err));
    return 0;
  }
}

export async function runTimedNotifications(now: Date): Promise<{ due: number; created: number }> {
  const due = await findDueNotifications(now);
  return { due: due.length, created: await createNotifications(due) };
}

// ---- Listing and reading ------------------------------------------------

export const MAX_PAGE_SIZE = 100;

export async function listNotifications(opts: { page: number; limit: number; type: NotificationType | null }) {
  const account = await getDefaultAccount();
  const where = { accountId: account.id, ...(opts.type ? { type: opts.type } : {}) };
  const [rows, total, unread] = await Promise.all([
    // Unread first (a null readAt sorts first), newest first within that.
    prisma.notification.findMany({ where, orderBy: [{ readAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }], skip: (opts.page - 1) * opts.limit, take: opts.limit }),
    prisma.notification.count({ where }),
    unreadCount(account.id),
  ]);
  return {
    items: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.createdAt, readAt: n.readAt })),
    page: opts.page,
    limit: opts.limit,
    total,
    unread,
    types: NOTIFICATION_TYPES,
  };
}

export const unreadCount = (accountId: string) => prisma.notification.count({ where: { accountId, readAt: null } });

// False when there is no such notification. Reading one twice keeps the
// first time.
export async function markRead(id: string): Promise<boolean> {
  const account = await getDefaultAccount();
  if (!(await prisma.notification.findFirst({ where: { id, accountId: account.id }, select: { id: true } }))) return false;
  await prisma.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
  return true;
}

export async function markAllRead(now = new Date()): Promise<number> {
  const account = await getDefaultAccount();
  const { count } = await prisma.notification.updateMany({ where: { accountId: account.id, readAt: null }, data: { readAt: now } });
  return count;
}

// ---- The morning digest -------------------------------------------------

const MAX_LINES_PER_TYPE = 25;

type DigestRow = { type: string; body: string; link: string };

// Grouped by type, in the order the types are listed above. Plain text: it
// fills one merge token in the digest email.
export function buildDigest(rows: DigestRow[], base: string): { count: number; body: string } {
  const sections: string[] = [];
  for (const { type, label } of NOTIFICATION_TYPES) {
    const mine = rows.filter((r) => r.type === type);
    if (mine.length === 0) continue;
    const lines = mine.slice(0, MAX_LINES_PER_TYPE).map((r) => `- ${r.body}\n  ${base}${r.link}`);
    if (mine.length > MAX_LINES_PER_TYPE) lines.push(`- and ${mine.length - MAX_LINES_PER_TYPE} more`);
    sections.push(`${label} (${mine.length})\n${lines.join("\n")}`);
  }
  return { count: rows.length, body: sections.join("\n\n") };
}

// The window is fixed to the 24 hours before 7:00 AM Eastern today, so every
// pass that day sees the same set and a late pass cannot send a different
// digest. A notification raised at 7:05 is in tomorrow's.
export function digestWindow(day: string): { start: Date; end: Date } {
  return { start: atEastern(addDays(day, -1), DIGEST_HOUR), end: atEastern(day, DIGEST_HOUR) };
}

export async function loadDigest(now: Date) {
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  const day = easternDay(now);
  const { start, end } = digestWindow(day);
  const rows = settings.digestEnabled ? await prisma.notification.findMany({ where: { accountId: account.id, readAt: null, createdAt: { gte: start, lt: end } }, orderBy: { createdAt: "asc" }, select: { type: true, body: true, link: true } }) : [];
  const base = adminBase();
  const built = buildDigest(rows, base);
  return { day, enabled: settings.digestEnabled, email: settings.digestEmail, count: built.count, extra: { digestCount: String(built.count), digestBody: built.body, digestLink: `${base}/notifications` } };
}
