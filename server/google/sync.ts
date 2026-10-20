import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { redact, safeErr } from "../log.js";
import { prettyPhone } from "../messageContext.js";
import { getSettings } from "../settings.js";
import { apiBase } from "../contract/links.js";
import { displayStatus } from "../../src/lib/bookingStatus.js";
import { GoogleError, deleteEvent, getEvent, insertEvent, updateEvent, type EventPayload } from "./client.js";
import { accessToken } from "./connection.js";
import { internalEventPayload, inviteEventPayload, syncHash, type BookingForCalendar, type CompanyForCalendar } from "./payload.js";

// One-way sync, app to Google, never the reverse. A booking gets GO's internal
// event once it reaches the chosen stage, and a customer invite when the
// switch is on and there is an email. Both ids live on the booking, so a
// booking never gets a second event; an unchanged booking is not re-sent (the
// payload fingerprint says so); a booking that is cancelled, released or
// drops below the stage loses both events (the customer gets Google's
// cancellation). Nothing here throws into whatever asked for the sync: a
// failure is written on the booking, redacted, and retried next hour.

export type SyncOutcome = { bookingId: string; action: "created" | "updated" | "deleted" | "unchanged" | "skipped" | "failed"; detail?: string };

// Whether a booking is far enough along to be on the calendar.
export function reachesStage(b: { status: string; retainerPaid: boolean }, stage: "Confirmed" | "Signed"): boolean {
  const shown = displayStatus(b);
  if (shown === "Cancelled" || shown === "Released") return false;
  if (shown === "Completed") return true;
  if (stage === "Signed") return shown === "Signed" || shown === "Confirmed";
  return shown === "Confirmed";
}

async function loadForCalendar(bookingId: string): Promise<(BookingForCalendar & { status: string; retainerPaid: boolean; googleEventId: string | null; googleInviteEventId: string | null; googleSyncHash: string | null }) | null> {
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      units: { include: { unit: { select: { item: { select: { id: true, name: true } } } } } },
      gigs: { where: { status: { not: "Cancelled" } }, select: { itemId: true, itemName: true, skill: true, filledBy: { select: { name: true } } } },
    },
  });
  if (!b) return null;
  const items = new Map<string, { name: string; quantity: number }>();
  for (const row of b.units) {
    const cur = items.get(row.unit.item.id) ?? { name: row.unit.item.name, quantity: 0 };
    cur.quantity += 1;
    items.set(row.unit.item.id, cur);
  }
  for (const g of b.gigs) {
    if (g.itemId && !items.has(g.itemId)) items.set(g.itemId, { name: g.itemName, quantity: 1 });
  }
  return {
    id: b.id,
    customerName: b.customerName,
    occasion: b.occasion,
    eventDate: b.eventDate.toISOString().slice(0, 10),
    eventTime: b.eventTime,
    timeFrom: b.timeFrom,
    timeTo: b.timeTo,
    address: b.address,
    venueName: b.venueName,
    onsiteContactName: b.onsiteContactName,
    onsiteContactPhone: b.onsiteContactPhone,
    phone: b.phone,
    email: b.email,
    items: [...items.values()],
    crew: b.gigs.filter((g) => g.filledBy).map((g) => ({ name: g.filledBy!.name, role: g.skill })),
    status: b.status,
    retainerPaid: b.retainerPaid,
    googleEventId: b.googleEventId,
    googleInviteEventId: b.googleInviteEventId,
    googleSyncHash: b.googleSyncHash,
  };
}

async function companyFor(accountId: string): Promise<CompanyForCalendar> {
  const s = await getSettings(accountId);
  const storefront = process.env.STOREFRONT_URL?.replace(/\/$/, "") ?? null;
  return { name: s.contractCompanyName, phone: s.contractPhone.replace(/\s*\(.*\)$/, "") || prettyPhone(process.env.TWILIO_PHONE_NUMBER), email: s.contractEmail, portalUrl: storefront ? `${storefront}/party` : null, adminUrl: apiBase() };
}

type Conn = { calendarId: string; invitesCalendarId: string | null; sendInvites: boolean; syncStage: "Confirmed" | "Signed" };

async function connection(accountId: string): Promise<Conn | null> {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { googleRefreshTokenEnc: true, googleCalendarId: true, googleInvitesCalendarId: true, googleSendInvites: true, googleSyncStage: true, googleNeedsReconnect: true } });
  if (!a.googleRefreshTokenEnc || a.googleNeedsReconnect) return null;
  return { calendarId: a.googleCalendarId ?? "primary", invitesCalendarId: a.googleInvitesCalendarId, sendInvites: a.googleSendInvites, syncStage: a.googleSyncStage === "Signed" ? "Signed" : "Confirmed" };
}

// Syncs one booking. Never throws.
export async function syncBooking(bookingId: string, opts: { conn?: Conn | null; token?: string; verify?: boolean } = {}): Promise<SyncOutcome> {
  try {
    const account = await getDefaultAccount();
    const conn = opts.conn === undefined ? await connection(account.id) : opts.conn;
    if (!conn) return { bookingId, action: "skipped", detail: "not connected" };
    const b = await loadForCalendar(bookingId);
    if (!b) return { bookingId, action: "skipped", detail: "not found" };
    const wanted = reachesStage(b, conn.syncStage);
    const hasEvents = b.googleEventId !== null || b.googleInviteEventId !== null;
    if (!wanted && !hasEvents) return { bookingId, action: "skipped", detail: "not at the chosen stage" };

    const token = opts.token ?? (await accessToken(account.id));
    if (!wanted) {
      if (b.googleEventId) await deleteEvent(token, conn.calendarId, b.googleEventId, "none");
      if (b.googleInviteEventId && conn.invitesCalendarId) await deleteEvent(token, conn.invitesCalendarId, b.googleInviteEventId, "all");
      await prisma.booking.update({ where: { id: bookingId }, data: { googleEventId: null, googleInviteEventId: null, googleSyncHash: null, googleSyncedAt: new Date(), googleSyncError: null } });
      return { bookingId, action: "deleted" };
    }

    const company = await companyFor(account.id);
    const internal = internalEventPayload(b, company);
    const inviteWanted = conn.sendInvites && conn.invitesCalendarId !== null;
    const invite: EventPayload | null = inviteWanted ? inviteEventPayload(b, company) : null;
    const hash = syncHash(internal, invite);
    const needsInviteDelete = b.googleInviteEventId !== null && invite === null;
    if (hash === b.googleSyncHash && b.googleEventId && !needsInviteDelete && (invite === null || b.googleInviteEventId)) {
      // The hourly pass also asks Google whether the events are still there;
      // one removed or cancelled by hand is made again below.
      if (!opts.verify) return { bookingId, action: "unchanged" };
      const live = async (calendarId: string | null, id: string | null) => {
        if (!calendarId || !id) return true;
        const e = await getEvent(token, calendarId, id);
        return e !== null && e.status !== "cancelled";
      };
      if ((await live(conn.calendarId, b.googleEventId)) && (await live(conn.invitesCalendarId, b.googleInviteEventId))) return { bookingId, action: "unchanged" };
    }

    let eventId = b.googleEventId;
    let inviteId = b.googleInviteEventId;
    let action: SyncOutcome["action"] = eventId ? "updated" : "created";
    if (eventId) {
      try {
        await updateEvent(token, conn.calendarId, eventId, internal, "none");
      } catch (err) {
        // The event was removed on Google's side: make it again, once.
        if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) {
          eventId = (await insertEvent(token, conn.calendarId, internal, "none")).id;
          action = "created";
        } else throw err;
      }
    } else {
      eventId = (await insertEvent(token, conn.calendarId, internal, "none")).id;
    }
    if (invite && conn.invitesCalendarId) {
      if (inviteId) {
        try {
          await updateEvent(token, conn.invitesCalendarId, inviteId, invite, "all");
        } catch (err) {
          if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) inviteId = (await insertEvent(token, conn.invitesCalendarId, invite, "all")).id;
          else throw err;
        }
      } else {
        inviteId = (await insertEvent(token, conn.invitesCalendarId, invite, "all")).id;
      }
    } else if (inviteId) {
      if (conn.invitesCalendarId) await deleteEvent(token, conn.invitesCalendarId, inviteId, "all");
      inviteId = null;
    }
    await prisma.booking.update({ where: { id: bookingId }, data: { googleEventId: eventId, googleInviteEventId: inviteId, googleSyncHash: hash, googleSyncedAt: new Date(), googleSyncError: null } });
    return { bookingId, action };
  } catch (err) {
    const detail = err instanceof GoogleError ? err.message : safeErr(err);
    console.warn(`[google] sync of booking ${bookingId} failed: ${redact(detail)}`);
    await prisma.booking.update({ where: { id: bookingId }, data: { googleSyncError: redact(detail).slice(0, 300) } }).catch(() => undefined);
    return { bookingId, action: "failed", detail: redact(detail) };
  }
}

// Fire and forget, for the flows that change a booking: nothing waits on
// Google and nothing can fail because of it.
export function queueGoogleSync(bookingId: string): void {
  setImmediate(() => {
    syncBooking(bookingId).catch((err) => console.warn("[google] sync could not run:", safeErr(err)));
  });
}

export type ReconcileResult = { ranAt: string; connected: boolean; checked: number; created: number; updated: number; deleted: number; unchanged: number; failed: number; needsReconnect: boolean; errors: string[] };

// Every booking in the next 120 days that is at the stage or has an event
// gets looked at, so anything missed or drifted is repaired. Runs from the
// hourly automation pass and from "Sync now".
export async function reconcileCalendar(now = new Date()): Promise<ReconcileResult> {
  const account = await getDefaultAccount();
  const result: ReconcileResult = { ranAt: now.toISOString(), connected: false, checked: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0, needsReconnect: false, errors: [] };
  const conn = await connection(account.id);
  if (!conn) {
    const a = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { googleNeedsReconnect: true } });
    result.needsReconnect = a.googleNeedsReconnect;
    return result;
  }
  result.connected = true;
  let token: string;
  try {
    token = await accessToken(account.id);
  } catch (err) {
    result.needsReconnect = err instanceof GoogleError && err.revoked;
    result.errors.push(err instanceof GoogleError ? err.message : safeErr(err));
    await prisma.account.update({ where: { id: account.id }, data: { googleLastSyncAt: now, googleLastSyncResult: result } }).catch(() => undefined);
    return result;
  }
  const today = now.toISOString().slice(0, 10);
  const bookings = await prisma.booking.findMany({
    where: {
      accountId: account.id,
      OR: [{ eventDate: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${addDays(today, 120)}T00:00:00Z`) } }, { googleEventId: { not: null } }, { googleInviteEventId: { not: null } }],
    },
    select: { id: true },
    orderBy: { eventDate: "asc" },
  });
  for (const b of bookings) {
    const o = await syncBooking(b.id, { conn, token, verify: true });
    if (o.action === "skipped") continue;
    result.checked++;
    if (o.action === "created") result.created++;
    else if (o.action === "updated") result.updated++;
    else if (o.action === "deleted") result.deleted++;
    else if (o.action === "unchanged") result.unchanged++;
    else if (o.action === "failed") {
      result.failed++;
      if (o.detail && result.errors.length < 5) result.errors.push(o.detail);
    }
  }
  const a = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { googleNeedsReconnect: true } });
  result.needsReconnect = a.googleNeedsReconnect;
  await prisma.account.update({ where: { id: account.id }, data: { googleLastSyncAt: now, googleLastSyncResult: result } }).catch(() => undefined);
  return result;
}
