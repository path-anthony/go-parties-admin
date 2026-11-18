import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";

// Block FIX1. Stock for items that do not lock a unit, and the optional
// "Maximum bookings per day" on any item.
//
// An item that counts against stock is held through its units, as before.
// One that does not (per-guest catering by default) holds no unit: the
// booking records it as a booking line, any number of bookings can have it
// on the same day, and only its daily maximum, when set, limits that.
//
// The daily count is every booking still going ahead that has the item on
// that date, through a unit or through a line. Counting and the write that
// follows are kept honest by a transaction-scoped advisory lock on the item
// and the date, so two holds racing for the last place cannot both win.

const LIVE = ["Held", "Contract Sent", "Signed", "Completed"];

export class DailyMaxReached extends Error {
  readonly itemName: string;
  readonly max: number;
  constructor(itemName: string, max: number) {
    super(`${itemName} is fully booked that day`);
    this.itemName = itemName;
    this.max = max;
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

// Bookings going ahead that have the item on the date.
export async function bookingsWithItemOn(db: Db, itemId: string, date: string, excludeBookingId: string | null = null): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(DISTINCT b.id)::int AS n
    FROM bookings b
    WHERE b.event_date = ${date}::date
      AND b.status = ANY(${LIVE}::text[])
      AND (${excludeBookingId}::text IS NULL OR b.id <> ${excludeBookingId}::text)
      AND (
        EXISTS (SELECT 1 FROM booking_lines l WHERE l.booking_id = b.id AND l.item_id = ${itemId})
        OR EXISTS (SELECT 1 FROM booking_units bu JOIN units u ON u.id = bu.unit_id WHERE bu.booking_id = b.id AND u.item_id = ${itemId})
      )`;
  return row?.n ?? 0;
}

// Inside a transaction: takes the item-and-date lock, then refuses when the
// day is full. A blank maximum never refuses.
export async function claimDailyPlace(tx: Prisma.TransactionClient, item: { id: string; name: string; maxPerDay: number | null }, date: string, excludeBookingId: string | null = null): Promise<void> {
  if (item.maxPerDay === null || item.maxPerDay === undefined) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`item-day:${item.id}:${date}`}))`;
  const used = await bookingsWithItemOn(tx, item.id, date, excludeBookingId);
  if (used >= item.maxPerDay) throw new DailyMaxReached(item.name, item.maxPerDay);
}

// How many more bookings can have each non-stock item on a date: the daily
// maximum less what is booked, or null for no limit. For the storefront's
// date-first browse; one query per item with a maximum, none otherwise.
export async function placesLeftByItem(items: { id: string; maxPerDay: number | null }[], date: string): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const item of items) {
    if (item.maxPerDay === null || item.maxPerDay === undefined) out.set(item.id, null);
    else out.set(item.id, Math.max(0, item.maxPerDay - (await bookingsWithItemOn(prisma, item.id, date))));
  }
  return out;
}

// What the storefront reads as "free" for an item that holds no unit and has
// no daily maximum: enough that no quantity control or "Booked" badge ever
// limits it.
export const NO_STOCK_LIMIT = 999;
