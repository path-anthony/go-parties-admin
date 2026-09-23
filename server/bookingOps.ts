import { Prisma } from "../src/generated/prisma/client.js";
import { describeAddon, resolveAddons } from "./addons.js";
import { lockFreeUnit } from "./availability.js";
import { prisma } from "./db.js";
import { BOOKING_GIGS_SELECT, cancelGigs, createGigs, moveGigs, needsCrew } from "./gigs.js";

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
  gigs: BOOKING_GIGS_SELECT,
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

// Cancelling releases the booking's units and cancels its gigs, so
// neither a date nor a crew need is held for something not happening.
export async function cancelBooking(bookingId: string, activity: string): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    await releaseUnits(tx, bookingId);
    await cancelGigs(tx, bookingId);
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
      // The booking's gigs move too, each checked for a free person on
      // the new date; if any can't be covered the whole move is refused.
      await moveGigs(tx, booking.accountId, bookingId, change.date);
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
// The target takes whatever it needs: a unit if it has units, a gig per
// skill if it has skills, both if both. A target with no units hands back
// a placeholder "unit" labelled Crew, so callers that show a label have
// one.
export async function changeBookingItem(
  bookingId: string,
  item: { id: string; name: string; skills: string[]; unitCount: number },
  activity: (booking: BookingWithUnits, unitLabel: string) => string,
): Promise<{ booking: BookingWithUnits; unit: { id: string | null; label: string } }> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const dateText = booking.eventDate.toISOString().slice(0, 10);
    // Units first, then crew, the lock order every path uses. Nothing is
    // released until the new item is fully covered, so a failure leaves
    // the booking as it was.
    let unit: { id: string | null; label: string } = { id: null, label: "Crew" };
    if (item.unitCount > 0) {
      const locked = await lockFreeUnit(tx, item.id, dateText);
      if (!locked) throw new NoFreeUnit(item.name);
      unit = locked;
    }
    await releaseUnits(tx, bookingId);
    await cancelGigs(tx, bookingId);
    if (unit.id) await tx.bookingUnit.create({ data: { bookingId, unitId: unit.id, eventDate: booking.eventDate } });
    if (needsCrew(item)) {
      await createGigs(tx, { accountId: booking.accountId, bookingId, date: booking.eventDate, wanted: [{ item, quantity: 1 }] });
    }
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

// Adds one of an item to a booking for the booking's own date, the way a
// direct booking claims one: a free unit is locked (SKIP LOCKED) if the
// item has units, then one gig per skill is created under the crew lock
// if it has skills, both if both. NoFreeUnit or NoCrewFree means nothing
// was written. Add-on choices already made for that item cover the new
// one. The item is charged once whichever of those it needed.
export async function addBookingItem(
  bookingId: string,
  item: { id: string; name: string; price: unknown; skills: string[]; unitCount: number },
): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    if (booking.status === "Cancelled") {
      throw new BookingEditError("A cancelled booking can't hold items. Set it back to Confirmed first.");
    }
    if (item.unitCount === 0 && !needsCrew(item)) {
      throw new BookingEditError(`${item.name} has no units and needs no crew, so there is nothing to hold. Give it a unit first.`);
    }
    const dateText = booking.eventDate.toISOString().slice(0, 10);
    let label = "crew";
    if (item.unitCount > 0) {
      const unit = await lockFreeUnit(tx, item.id, dateText);
      if (!unit) throw new NoFreeUnit(item.name);
      await tx.bookingUnit.create({ data: { bookingId, unitId: unit.id, eventDate: booking.eventDate } });
      label = unit.label;
    }
    if (needsCrew(item)) {
      await createGigs(tx, { accountId: booking.accountId, bookingId, date: booking.eventDate, wanted: [{ item, quantity: 1 }] });
    }
    const itemAddons = booking.addons.filter((a) => a.itemId === item.id);
    if (itemAddons.length > 0) {
      await tx.bookingAddon.updateMany({ where: { bookingId, itemId: item.id }, data: { quantity: { increment: 1 } } });
    }
    const addonsPerUnit = itemAddons.reduce((sum, a) => sum + Number(a.priceDelta), 0);
    await adjustTotal(tx, booking, (item.price === null ? 0 : Number(item.price)) + addonsPerUnit);
    const crewNote = needsCrew(item) ? `, needs ${item.skills.join(", ")}` : "";
    await logActivity(tx, booking.leadId, `Added ${item.name} (${label}${crewNote}) to the booking from the admin.`);
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
  });
}

// How many complete "ones" of an item a set of live gigs amounts to: one
// per skill each. An item needing three people has one instance per three
// gigs. Used to charge and refund the item's price by the instance, not
// by the gig.
function instancesOf(gigs: { itemId: string | null; status: string }[], itemId: string, skillCount: number): number {
  if (skillCount === 0) return 0;
  return Math.floor(gigs.filter((g) => g.itemId === itemId && g.status !== "Cancelled").length / skillCount);
}

// Takes one gig off a booking. For an item held only through its crew
// (no units), the item's price and its add-ons come off the total when
// the removal drops a complete instance of it (one gig per skill); for an
// item that also holds a unit, the unit is what carries the price, so
// removing a gig only removes the crew need.
export async function removeBookingGig(bookingId: string, gigId: string): Promise<BookingWithUnits> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: WITH_UNIT_DETAILS });
    const gig = await tx.gig.findFirst({
      where: { id: gigId, bookingId },
      include: { filledBy: { select: { name: true } }, item: { select: { price: true, skills: true, _count: { select: { units: true } } } } },
    });
    if (!gig) throw new BookingEditError("That gig isn't on this booking.");
    const skillCount = gig.item?.skills.length ?? 1;
    const unitBacked = (gig.item?._count.units ?? 0) > 0 && booking.units.some((u) => u.unit.item.id === gig.itemId);
    const before = gig.itemId ? instancesOf(booking.gigs, gig.itemId, skillCount) : 0;

    await tx.gig.delete({ where: { id: gig.id } });
    const after = gig.itemId ? instancesOf(booking.gigs.filter((g) => g.id !== gig.id), gig.itemId, skillCount) : 0;
    const lostInstances = unitBacked ? 0 : Math.max(0, before - after);
    const itemAddons = gig.itemId ? booking.addons.filter((a) => a.itemId === gig.itemId) : [];
    if (lostInstances > 0 && itemAddons.length > 0) {
      if (after === 0) await tx.bookingAddon.deleteMany({ where: { bookingId, itemId: gig.itemId as string } });
      else await tx.bookingAddon.updateMany({ where: { bookingId, itemId: gig.itemId as string }, data: { quantity: { decrement: lostInstances } } });
    }
    const addonsPerUnit = itemAddons.reduce((sum, a) => sum + Number(a.priceDelta), 0);
    if (gig.status !== "Cancelled" && lostInstances > 0) {
      await adjustTotal(tx, booking, -lostInstances * ((gig.item?.price == null ? 0 : Number(gig.item.price)) + addonsPerUnit));
    }
    const who = gig.filledBy ? `, which ${gig.filledBy.name} had accepted` : "";
    await logActivity(tx, booking.leadId, `Removed ${gig.itemName} from the booking from the admin${who}.`);
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
    // A unit of an item that also needs crew takes its people with it:
    // one live gig per skill, the newest first.
    const skills = (await tx.item.findUnique({ where: { id: item.id }, select: { skills: true } }))?.skills ?? [];
    for (const skill of skills) {
      const gig = await tx.gig.findFirst({
        where: { bookingId, itemId: item.id, skill, status: { not: "Cancelled" } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (gig) await tx.gig.delete({ where: { id: gig.id } });
    }
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
    const quantity =
      booking.units.filter((u) => u.unit.item.id === item.id).length +
      booking.gigs.filter((g) => g.itemId === item.id && g.status !== "Cancelled").length;
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

// The portal reads a booking's items off `units`, so a service item (a
// gig, no physical unit) is listed there too with a null unitId and the
// label "Crew", and again under `gigs` with its skill and status.
export function serializeCustomerBooking(booking: BookingWithUnits) {
  const { units, addons, gigs, customerId: _customerId, accountId: _accountId, ...rest } = booking;
  const liveGigs = gigs.filter((g) => g.status !== "Cancelled");
  return {
    ...rest,
    gigs: liveGigs.map((g) => ({ id: g.id, itemId: g.itemId, itemName: g.itemName, skill: g.skill, status: g.status })),
    addons: addons.map((a) => ({
      itemId: a.itemId,
      itemName: a.itemName,
      groupName: a.groupName,
      addonName: a.addonName,
      priceDelta: Number(a.priceDelta),
      quantity: a.quantity,
    })),
    units: [
      ...units.map((row) => ({
        unitId: row.unit.id as string | null,
        unitLabel: row.unit.label,
        itemId: row.unit.item.id as string | null,
        itemName: row.unit.item.name,
      })),
      ...liveGigs.map((g) => ({ unitId: null, unitLabel: "Crew", itemId: g.itemId, itemName: g.itemName })),
    ],
  };
}
