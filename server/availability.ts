import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";

// A unit is free on a date when its manual status is Available (Booked and
// Maintenance are hand-set blocks that apply to every date) and no
// booking_units row holds it for that date. The row carries the date
// itself, backed by the (unit_id, event_date) unique index, and a
// cancelled booking has no rows, so no status check is needed here.
function freeUnitsWhere(itemId: string, date: string) {
  return Prisma.sql`
    u.item_id = ${itemId}
    AND u.status = 'Available'
    AND NOT EXISTS (
      SELECT 1
      FROM booking_units bu
      WHERE bu.unit_id = u.id
        AND bu.event_date = ${date}::date
    )`;
}

export async function countFreeUnits(itemId: string, date: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ free: number }[]>`
    SELECT count(*)::int AS free FROM units u WHERE ${freeUnitsWhere(itemId, date)}`;
  return row?.free ?? 0;
}

// Free unit counts for every item on one date in a single query, for the
// storefront's date-first browse (asking per item would be one request per
// catalog row per date change). Same definition of free as above. Items
// with no free unit are simply absent from the map.
export async function freeUnitsByItem(accountId: string, date: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ item_id: string; free: number }[]>`
    SELECT u.item_id, count(*)::int AS free
    FROM units u
    JOIN items i ON i.id = u.item_id
    WHERE i.account_id = ${accountId}
      AND u.status = 'Available'
      AND NOT EXISTS (
        SELECT 1
        FROM booking_units bu
        WHERE bu.unit_id = u.id
          AND bu.event_date = ${date}::date
      )
    GROUP BY u.item_id`;
  return new Map(rows.map((row) => [row.item_id, row.free]));
}

// Locks and returns one free unit, or null. Must run inside a transaction:
// FOR UPDATE holds the unit row until that transaction ends, and SKIP
// LOCKED makes a concurrent caller pass over it instead of waiting, so two
// requests racing for the last unit can't both pick it. The loser sees no
// row and reports the date as taken. (Waiting instead of skipping would be
// unsafe here: under READ COMMITTED the NOT EXISTS subquery keeps the
// statement's original snapshot, so the waiter could still see the unit as
// free after the winner committed.)
//
// excludeUnitIds matters when one transaction claims several units of the
// same item: SKIP LOCKED only skips rows locked by other transactions, so
// without it the same unit would be handed back a second time.
export async function lockFreeUnit(
  tx: Prisma.TransactionClient,
  itemId: string,
  date: string,
  excludeUnitIds: string[] = [],
): Promise<{ id: string; label: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; label: string }[]>`
    SELECT u.id, u.label FROM units u
    WHERE ${freeUnitsWhere(itemId, date)}
      AND NOT (u.id = ANY(${excludeUnitIds}::text[]))
    ORDER BY u.label ASC
    LIMIT 1
    FOR UPDATE OF u SKIP LOCKED`;
  return rows[0] ?? null;
}

// Where a storefront booking's lead lands: the column literally named
// "Booked" (any case) if one exists, else the first column.
export async function leadStatusForStorefrontBooking(accountId: string): Promise<string> {
  const columns = await prisma.leadStatus.findMany({ where: { accountId }, orderBy: { position: "asc" } });
  const booked = columns.find((column) => column.name.toLowerCase() === "booked");
  const chosen = booked ?? columns[0];
  if (!chosen) throw new Error("No lead columns exist for this account");
  return chosen.name;
}
