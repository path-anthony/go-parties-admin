import { getDefaultAccount } from "./account.js";
import { releaseBooking } from "./bookingOps.js";
import { prisma } from "./db.js";
import { getSettings } from "./settings.js";

// Optional hold expiry. When "Release unpaid storefront holds after N days" is
// set (Settings > Business rules; 0 = never), the hourly automation run
// releases a booking that a customer made on the storefront and left unpaid:
// still at Held, retainer not paid, older than N days. Bookings staff made are
// never touched: a storefront booking is told apart by its lead, whose source
// is "storefront" (staff-made bookings create a "manual" lead).

export type HoldRelease = { bookingId: string; customerName: string; eventDate: string; heldDays: number };

export async function findExpiredHolds(now = new Date()): Promise<{ days: number; holds: HoldRelease[] }> {
  const account = await getDefaultAccount();
  const { holdReleaseDays } = await getSettings(account.id);
  if (holdReleaseDays <= 0) return { days: 0, holds: [] };
  const cutoff = new Date(now.getTime() - holdReleaseDays * 86_400_000);
  const rows = await prisma.booking.findMany({
    where: { accountId: account.id, status: "Held", retainerPaid: false, createdAt: { lt: cutoff }, lead: { is: { source: "storefront" } } },
    select: { id: true, customerName: true, eventDate: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    days: holdReleaseDays,
    holds: rows.map((b) => ({ bookingId: b.id, customerName: b.customerName, eventDate: b.eventDate.toISOString().slice(0, 10), heldDays: Math.floor((now.getTime() - b.createdAt.getTime()) / 86_400_000) })),
  };
}

export async function releaseExpiredHolds(now = new Date()): Promise<{ days: number; released: HoldRelease[] }> {
  const { days, holds } = await findExpiredHolds(now);
  const released: HoldRelease[] = [];
  for (const h of holds) {
    if (await releaseBooking(h.bookingId, `Released: the hold was not paid within ${days} days.`)) released.push(h);
  }
  return { days, released };
}
