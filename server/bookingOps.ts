import { Prisma } from "../src/generated/prisma/client.js";
import { describeAddon, resolveAddons } from "./addons.js";
import { lockFreeUnit } from "./availability.js";
import { prisma } from "./db.js";

// Thrown inside a transaction when no unit of an item can be locked for a
// date, so the whole transaction rolls back and nothing is left half done.
export class NoFreeUnit extends Error {
  readonly itemName: string;

  constructor(itemName: string) {
    super(`No free unit of ${itemName}`);
    this.itemName = itemName;
  }
}

// Same idea for a request that asked for several items at once: every
// item that couldn't be locked is named, so the customer knows what to
// drop, and the transaction still rolls back as a whole.
export class NoFreeUnits extends Error {
  readonly itemNames: string[];

  constructor(itemNames: string[]) {
    super(`No free unit of ${itemNames.join(", ")}`);
    this.itemNames = itemNames;
  }
}

type Tx = Prisma.TransactionClient;

const WITH_UNIT_DETAILS = {
  units: { include: { unit: { include: { item: { select: { id: true, name: true, price: true } } } } } },
  addons: { orderBy: { createdAt: "asc" } },
} as const;

export type BookingWithUnits = Prisma.BookingGetPayload<{ include: typeof WITH_UNIT_DETAILS }>;

// Deleting a booking's join rows is what releases its units: the
// (unitId, eventDate) unique constraint then no longer holds the date.
// Used by the admin's cancel path and by the customer's.
export function releaseUnits(tx: Tx | typeof prisma, bookingId: string) {
  return tx.bookingUnit.deleteMany({ where: { bookingId } });
}

async function logActivity(tx: Tx, leadId: string | null, text: string) {
  if (leadId) await tx.leadActivity.create({ data: { leadId, text } });
}

export async function cancelBooking(bookingId: string, activity: string): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    await releaseUnits(tx, bookingId);
    const booking = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "Cancelled" },
      include: WITH_UNIT_DETAILS,
    });
    await logActivity(tx, booking.leadId, activity);
    return booking;
  });
}

// Moves a booking to a new date and/or time. A date change re-claims every
// unit the booking holds under the same lock the original booking used:
// for each held unit's item, one free unit on the new date is locked
// (SKIP LOCKED) before anything is released, so if any item has nothing
// free the transaction throws NoFreeUnit and the booking is untouched. A
// time-only change never touches units.
export async function rescheduleBooking(
  bookingId: string,
  change: { date?: Date; time?: string | null },
  activity: (booking: BookingWithUnits) => string,
): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const data: { eventDate?: Date; eventTime?: string | null } = {};
    if (change.time !== undefined) data.eventTime = change.time;

    const dateChanged = change.date !== undefined && change.date.getTime() !== booking.eventDate.getTime();
    if (change.date && dateChanged) {
      const dateText = change.date.toISOString().slice(0, 10);
      const claimed: string[] = [];
      for (const row of booking.units) {
        const unit = await lockFreeUnit(tx, row.unit.item.id, dateText, claimed);
        if (!unit) throw new NoFreeUnit(row.unit.item.name);
        claimed.push(unit.id);
      }
      await releaseUnits(tx, bookingId);
      if (claimed.length > 0) {
        await tx.bookingUnit.createMany({
          data: claimed.map((unitId) => ({ bookingId, unitId, eventDate: change.date as Date })),
        });
      }
      data.eventDate = change.date;
    }

    const updated = await tx.booking.update({ where: { id: bookingId }, data, include: WITH_UNIT_DETAILS });
    await logActivity(tx, updated.leadId, activity(updated));
    return updated;
  });
}

// Swaps the booking onto one unit of a different item for the same date.
// The new unit is locked first; only then are the old units released, so
// a failure leaves the original booking exactly as it was. The linked
// lead's occasion follows the new item.
export async function changeBookingItem(
  bookingId: string,
  item: { id: string; name: string },
  activity: (booking: BookingWithUnits, unitLabel: string) => string,
): Promise<{ booking: BookingWithUnits; unit: { id: string; label: string } }> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const dateText = booking.eventDate.toISOString().slice(0, 10);
    const unit = await lockFreeUnit(tx, item.id, dateText);
    if (!unit) throw new NoFreeUnit(item.name);

    await releaseUnits(tx, bookingId);
    await tx.bookingUnit.create({ data: { bookingId, unitId: unit.id, eventDate: booking.eventDate } });
    // Add-on choices belong to the item they were made for. They go with
    // the old item, and what they added comes off the quoted total.
    if (booking.addons.length > 0) {
      const dropped = booking.addons.reduce((sum, a) => sum + Number(a.priceDelta) * a.quantity, 0);
      await tx.bookingAddon.deleteMany({ where: { bookingId } });
      if (booking.total !== null) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { total: Math.round((Number(booking.total) - dropped) * 100) / 100 },
        });
      }
    }
    if (booking.leadId) {
      await tx.lead.update({ where: { id: booking.leadId }, data: { occasion: item.name } });
    }
    const updated = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    await logActivity(tx, updated.leadId, activity(updated, unit.label));
    return { booking: updated, unit };
  });
}

// Thrown for an admin edit that can't apply to the booking as it stands.
export class BookingEditError extends Error {}

const cents = (n: number) => Math.round(n * 100) / 100;

// The quoted total follows admin edits by the amount of the edit, and only
// when there is a quote to follow: an admin-entered booking has no total
// and keeps none.
async function adjustTotal(tx: Tx, booking: { id: string; total: unknown }, by: number) {
  if (booking.total === null || by === 0) return;
  await tx.booking.update({ where: { id: booking.id }, data: { total: cents(Number(booking.total) + by) } });
}

// Adds one unit of an item to a booking for the booking's own date, the
// way a direct booking claims one: a free unit is locked (SKIP LOCKED)
// inside the transaction, so it can't also be handed to a customer who is
// booking the same date at that moment, and NoFreeUnit means nothing was
// written. Add-on choices already made for that item cover the new unit.
export async function addBookingUnit(
  bookingId: string,
  item: { id: string; name: string; price: unknown },
): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    if (booking.status === "Cancelled") {
      throw new BookingEditError("A cancelled booking can't hold units. Set it back to Confirmed first.");
    }
    const dateText = booking.eventDate.toISOString().slice(0, 10);
    const unit = await lockFreeUnit(tx, item.id, dateText);
    if (!unit) throw new NoFreeUnit(item.name);

    await tx.bookingUnit.create({ data: { bookingId, unitId: unit.id, eventDate: booking.eventDate } });
    const itemAddons = booking.addons.filter((a) => a.itemId === item.id);
    if (itemAddons.length > 0) {
      await tx.bookingAddon.updateMany({ where: { bookingId, itemId: item.id }, data: { quantity: { increment: 1 } } });
    }
    const addonsPerUnit = itemAddons.reduce((sum, a) => sum + Number(a.priceDelta), 0);
    await adjustTotal(tx, booking, (item.price === null ? 0 : Number(item.price)) + addonsPerUnit);
    await logActivity(tx, booking.leadId, `Added ${item.name} (${unit.label}) to the booking from the admin.`);
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
  });
}

// Takes one unit off a booking, which frees it for that date. Add-on
// choices for the item shrink with it, and go entirely with its last unit.
export async function removeBookingUnit(bookingId: string, unitId: string): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const row = booking.units.find((u) => u.unitId === unitId);
    if (!row) throw new BookingEditError("That unit isn't on this booking.");
    const item = row.unit.item;
    const remaining = booking.units.filter((u) => u.unit.item.id === item.id).length - 1;

    await tx.bookingUnit.delete({ where: { bookingId_unitId: { bookingId, unitId } } });
    const itemAddons = booking.addons.filter((a) => a.itemId === item.id);
    if (itemAddons.length > 0) {
      if (remaining === 0) await tx.bookingAddon.deleteMany({ where: { bookingId, itemId: item.id } });
      else await tx.bookingAddon.updateMany({ where: { bookingId, itemId: item.id }, data: { quantity: { decrement: 1 } } });
    }
    const addonsPerUnit = itemAddons.reduce((sum, a) => sum + Number(a.priceDelta), 0);
    await adjustTotal(tx, booking, -((item.price === null ? 0 : Number(item.price)) + addonsPerUnit));
    await logActivity(tx, booking.leadId, `Removed ${item.name} (${row.unit.label}) from the booking from the admin.`);
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
  });
}

// Replaces the add-on choices for one item on a booking. Same rules as a
// customer's choices (the option belongs to the item, one per group),
// except a required group may be left open: this is Andy correcting a
// booking, not a customer checking out. Fresh copies of the names and
// price are stored, and the quoted total moves by the difference.
export async function setBookingItemAddons(
  bookingId: string,
  item: { id: string; name: string },
  addonIds: string[],
): Promise<BookingWithUnits> {
  const chosen = await resolveAddons([item], new Map([[item.id, addonIds]]), { enforceRequired: false });
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const quantity = booking.units.filter((u) => u.unit.item.id === item.id).length;
    if (quantity === 0) throw new BookingEditError(`${item.name} isn't on this booking.`);

    // Only what changed is touched. A choice that stays keeps the name and
    // price it was sold at, even if the option has been repriced since. A
    // choice whose option has been deleted can't be re-picked, so it stays
    // as the record of what was sold until its unit is removed.
    const wanted = new Set(chosen.map((a) => a.addonId));
    const current = booking.addons.filter((a) => a.itemId === item.id && a.addonId !== null);
    const dropped = current.filter((a) => !wanted.has(a.addonId as string));
    const kept = new Set(current.filter((a) => wanted.has(a.addonId as string)).map((a) => a.addonId));
    const added = chosen.filter((a) => !kept.has(a.addonId));
    const beforeSum = dropped.reduce((sum, a) => sum + Number(a.priceDelta) * a.quantity, 0);
    const afterSum = added.reduce((sum, a) => sum + a.priceDelta * quantity, 0);
    if (dropped.length > 0) {
      await tx.bookingAddon.deleteMany({ where: { id: { in: dropped.map((a) => a.id) } } });
    }
    if (added.length > 0) {
      await tx.bookingAddon.createMany({
        data: added.map((a) => ({
          bookingId,
          itemId: a.itemId,
          addonId: a.addonId,
          itemName: a.itemName,
          groupName: a.groupName,
          addonName: a.addonName,
          priceDelta: a.priceDelta,
          quantity,
        })),
      });
    }
    await adjustTotal(tx, booking, afterSum - beforeSum);
    if (dropped.length === 0 && added.length === 0) return booking;
    const text = chosen.length > 0 ? chosen.map(describeAddon).join("; ") : "none";
    await logActivity(tx, booking.leadId, `Add-ons for ${item.name} set from the admin: ${text}.`);
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
  });
}

export function serializeCustomerBooking(booking: BookingWithUnits) {
  const { units, addons, customerId: _customerId, accountId: _accountId, ...rest } = booking;
  return {
    ...rest,
    addons: addons.map((a) => ({
      itemId: a.itemId,
      itemName: a.itemName,
      groupName: a.groupName,
      addonName: a.addonName,
      priceDelta: Number(a.priceDelta),
      quantity: a.quantity,
    })),
    units: units.map((row) => ({
      unitId: row.unit.id,
      unitLabel: row.unit.label,
      itemId: row.unit.item.id,
      itemName: row.unit.item.name,
    })),
  };
}
