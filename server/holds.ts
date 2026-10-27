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

export type HoldRelease = { bookingId: string; customerName: string; eventDate: string; heldDays: number; tier?: number | null };

// Block T1: a tier 2 hold (the contract signed at checkout, the retainer
// unpaid) has its own limit, "Release unpaid contract holds after N days".
export async function findExpiredHolds(now = new Date()): Promise<{ days: number; holds: HoldRelease[] }> {
  const account = await getDefaultAccount();
  const { holdReleaseDays, contractHoldReleaseDays } = await getSettings(account.id);
  const holds: HoldRelease[] = [];
  const shape = (b: { id: string; customerName: string; eventDate: Date; createdAt: Date; tier: number | null }): HoldRelease => ({
    bookingId: b.id,
    customerName: b.customerName,
    eventDate: b.eventDate.toISOString().slice(0, 10),
    heldDays: Math.floor((now.getTime() - b.createdAt.getTime()) / 86_400_000),
    tier: b.tier,
  });
  if (holdReleaseDays > 0) {
    const cutoff = new Date(now.getTime() - holdReleaseDays * 86_400_000);
    const rows = await prisma.booking.findMany({
      where: { accountId: account.id, status: "Held", retainerPaid: false, createdAt: { lt: cutoff }, lead: { is: { source: "storefront" } }, OR: [{ tier: null }, { tier: { not: 2 } }] },
      select: { id: true, customerName: true, eventDate: true, createdAt: true, tier: true },
      orderBy: { createdAt: "asc" },
    });
    holds.push(...rows.map(shape));
  }
  if (contractHoldReleaseDays > 0) {
    const cutoff = new Date(now.getTime() - contractHoldReleaseDays * 86_400_000);
    const rows = await prisma.booking.findMany({
      where: { accountId: account.id, tier: 2, status: { in: ["Held", "Contract Sent", "Signed"] }, retainerPaid: false, createdAt: { lt: cutoff }, lead: { is: { source: "storefront" } } },
      select: { id: true, customerName: true, eventDate: true, createdAt: true, tier: true },
      orderBy: { createdAt: "asc" },
    });
    holds.push(...rows.map(shape));
  }
  return { days: holdReleaseDays, holds };
}

export async function releaseExpiredHolds(now = new Date()): Promise<{ days: number; released: HoldRelease[] }> {
  const { days, holds } = await findExpiredHolds(now);
  const account = await getDefaultAccount();
  const { contractHoldReleaseDays } = await getSettings(account.id);
  const released: HoldRelease[] = [];
  for (const h of holds) {
    const limit = h.tier === 2 ? contractHoldReleaseDays : days;
    const ok = await releaseBooking(h.bookingId, h.tier === 2 ? `Released: the contract was signed but the retainer was not paid within ${limit} days.` : `Released: the hold was not paid within ${limit} days.`, h.tier === 2 ? ["Held", "Contract Sent", "Signed"] : ["Held"]);
    if (ok) released.push(h);
  }
  return { days, released };
}
