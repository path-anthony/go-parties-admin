import { Router, type Response } from "express";
import { getDefaultAccount } from "../account.js";
import { AddonSelectionError } from "../addons.js";
import {
  BookingEditError,
  NoFreeUnit,
  addBookingItem,
  releaseUnits,
  removeBookingGig,
  removeBookingUnit,
  rescheduleBooking,
  setBookingItemAddons,
} from "../bookingOps.js";
import { BOOKING_GIGS_SELECT, NoCrewFree } from "../gigs.js";
import { prisma } from "../db.js";
import { INVALID, isOneOf, normalizeDate, normalizeText } from "../validate.js";

const BOOKING_STATUSES = ["Confirmed", "Completed", "Cancelled"] as const;
const MAX_ADDRESS_LENGTH = 300;
const MAX_TIME_LENGTH = 60;

const router = Router();

const WITH_UNITS = {
  units: { select: { unitId: true } },
  addons: {
    select: { id: true, itemId: true, addonId: true, itemName: true, groupName: true, addonName: true, priceDelta: true, quantity: true },
    orderBy: { createdAt: "asc" as const },
  },
  gigs: BOOKING_GIGS_SELECT,
};
const ORDER = [{ eventDate: "asc" as const }, { createdAt: "asc" as const }];

// The join rows are an implementation detail; clients see a flat unitIds.
function serialize<T extends { units: { unitId: string }[] }>(booking: T) {
  const { units, ...rest } = booking;
  return { ...rest, unitIds: units.map((row) => row.unitId) };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown }).code === "P2002";
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Optional free text: absent, null, or blank all mean "none".
function optionalText(value: unknown, max: number): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const text = value.trim();
  if (text === "") return null;
  return text.length <= max ? text : INVALID;
}

async function resolveLeadId(accountId: string, value: unknown): Promise<string | null | typeof INVALID> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return INVALID;
  const lead = await prisma.lead.findFirst({ where: { id: value, accountId }, select: { id: true } });
  return lead ? lead.id : INVALID;
}

async function resolveUnitIds(accountId: string, value: unknown): Promise<string[] | typeof INVALID> {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string")) return INVALID;
  const ids = [...new Set(value)];
  if (ids.length === 0) return ids;
  const owned = await prisma.unit.count({ where: { id: { in: ids }, item: { accountId } } });
  return owned === ids.length ? ids : INVALID;
}

// Names the units already committed elsewhere on a date, for a specific
// message. This is only for wording: the (unitId, eventDate) unique
// constraint is the guarantee, and the write below still handles it.
async function describeConflicts(unitIds: string[], date: Date, excludeBookingId?: string): Promise<string | null> {
  if (unitIds.length === 0) return null;
  const taken = await prisma.bookingUnit.findMany({
    where: { unitId: { in: unitIds }, eventDate: date, ...(excludeBookingId ? { NOT: { bookingId: excludeBookingId } } : {}) },
    include: { unit: { include: { item: { select: { name: true } } } } },
  });
  if (taken.length === 0) return null;
  const names = taken.map((row) => `${row.unit.item.name} · ${row.unit.label}`).join(", ");
  return `${names} ${taken.length === 1 ? "is" : "are"} already booked for ${formatDay(date)}. Pick another unit or date.`;
}

// The same refusal the portal gives, worded for the admin: nothing moved.
function noFreeUnitMessage(itemName: string, date: Date): string {
  return `${itemName} has no free unit on ${formatDay(date)}, so nothing was changed. Pick another date, or free up a unit first.`;
}

function noCrewMessage(itemName: string, skill: string, date: Date): string {
  return `Nobody on the crew is free to cover the ${skill} for ${itemName} on ${formatDay(date)}, so nothing was changed. Pick another date, or add crew with that skill first.`;
}

const RACE_CONFLICT = "One of those units was just booked for that date by someone else. Pick another unit or date.";

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const bookings = await prisma.booking.findMany({ where: { accountId: account.id }, include: WITH_UNITS, orderBy: ORDER });
  res.json(bookings.map(serialize));
});

router.post("/", async (req, res) => {
  const { leadId, eventDate, eventTime, address, customerName, phone, email, status, unitIds } = req.body ?? {};

  const name = normalizeText(customerName);
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const phoneText = normalizeText(phone);
  const emailText = normalizeText(email);
  if (!phoneText || !emailText) {
    return res.status(400).json({ error: "phone and email are both required" });
  }
  const date = normalizeDate(eventDate);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  }
  const timeText = optionalText(eventTime, MAX_TIME_LENGTH);
  if (timeText === INVALID) {
    return res.status(400).json({ error: `eventTime must be text up to ${MAX_TIME_LENGTH} characters` });
  }
  const addressText = optionalText(address, MAX_ADDRESS_LENGTH);
  if (addressText === INVALID) {
    return res.status(400).json({ error: `address must be text up to ${MAX_ADDRESS_LENGTH} characters` });
  }
  if (status !== undefined && !isOneOf(BOOKING_STATUSES, status)) {
    return res.status(400).json({ error: `status must be one of ${BOOKING_STATUSES.join(", ")}` });
  }

  const account = await getDefaultAccount();
  const resolvedLead = await resolveLeadId(account.id, leadId);
  if (resolvedLead === INVALID) {
    return res.status(400).json({ error: "leadId must be a lead on this account" });
  }
  const resolvedUnits = await resolveUnitIds(account.id, unitIds ?? []);
  if (resolvedUnits === INVALID) {
    return res.status(400).json({ error: "unitIds must be units on this account" });
  }
  if (status === "Cancelled" && resolvedUnits.length > 0) {
    return res.status(400).json({ error: "A cancelled booking can't hold units" });
  }

  const conflict = await describeConflicts(resolvedUnits, date);
  if (conflict) {
    return res.status(409).json({ error: conflict, reason: "unit-conflict" });
  }

  try {
    const booking = await prisma.booking.create({
      data: {
        accountId: account.id,
        leadId: resolvedLead,
        eventDate: date,
        eventTime: timeText,
        address: addressText,
        customerName: name,
        phone: phoneText,
        email: emailText,
        status: status ?? "Confirmed",
        units: { create: resolvedUnits.map((unitId) => ({ unitId, eventDate: date })) },
      },
      include: WITH_UNITS,
    });
    res.status(201).json(serialize(booking));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: RACE_CONFLICT, reason: "unit-conflict" });
    }
    throw err;
  }
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.booking.findFirst({ where: { id, accountId: account.id }, include: WITH_UNITS });
  if (!existing) {
    return res.status(404).json({ error: "booking not found" });
  }

  const data: {
    leadId?: string | null;
    eventDate?: Date;
    eventTime?: string | null;
    address?: string | null;
    customerName?: string;
    phone?: string;
    email?: string;
    status?: string;
    depositPaid?: boolean;
  } = {};

  if ("depositPaid" in body) {
    if (typeof body.depositPaid !== "boolean") {
      return res.status(400).json({ error: "depositPaid must be true or false" });
    }
    data.depositPaid = body.depositPaid;
  }
  if ("customerName" in body) {
    const name = normalizeText(body.customerName);
    if (!name) return res.status(400).json({ error: "customerName is required" });
    data.customerName = name;
  }
  // Both stay required once set: an edit can change them, not blank them.
  if ("phone" in body) {
    const phoneText = normalizeText(body.phone);
    if (!phoneText) return res.status(400).json({ error: "phone is required" });
    data.phone = phoneText;
  }
  if ("email" in body) {
    const emailText = normalizeText(body.email);
    if (!emailText) return res.status(400).json({ error: "email is required" });
    data.email = emailText;
  }
  if ("eventDate" in body) {
    const date = normalizeDate(body.eventDate);
    if (date === null || date === INVALID) {
      return res.status(400).json({ error: "eventDate must be a valid YYYY-MM-DD date" });
    }
    data.eventDate = date;
  }
  if ("eventTime" in body) {
    const timeText = optionalText(body.eventTime, MAX_TIME_LENGTH);
    if (timeText === INVALID) return res.status(400).json({ error: `eventTime must be text up to ${MAX_TIME_LENGTH} characters` });
    data.eventTime = timeText;
  }
  if ("address" in body) {
    const addressText = optionalText(body.address, MAX_ADDRESS_LENGTH);
    if (addressText === INVALID) return res.status(400).json({ error: `address must be text up to ${MAX_ADDRESS_LENGTH} characters` });
    data.address = addressText;
  }
  if ("status" in body) {
    if (!isOneOf(BOOKING_STATUSES, body.status)) {
      return res.status(400).json({ error: `status must be one of ${BOOKING_STATUSES.join(", ")}` });
    }
    data.status = body.status;
  }
  if ("leadId" in body) {
    const resolvedLead = await resolveLeadId(account.id, body.leadId);
    if (resolvedLead === INVALID) return res.status(400).json({ error: "leadId must be a lead on this account" });
    data.leadId = resolvedLead;
  }

  let unitIds: string[] | null = null;
  if ("unitIds" in body) {
    const resolved = await resolveUnitIds(account.id, body.unitIds);
    if (resolved === INVALID) return res.status(400).json({ error: "unitIds must be units on this account" });
    unitIds = resolved;
  }

  if (Object.keys(data).length === 0 && unitIds === null) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const nextDate = data.eventDate ?? existing.eventDate;
  const nextStatus = data.status ?? existing.status;
  const dateMoved = data.eventDate !== undefined && data.eventDate.getTime() !== existing.eventDate.getTime();

  // A cancelled booking releases its units, so the unique constraint on
  // (unitId, eventDate) never holds a date for something that isn't
  // happening. Setting units on a cancelled booking is refused for the
  // same reason.
  const cancelling = nextStatus === "Cancelled";
  if (cancelling && unitIds !== null && unitIds.length > 0) {
    return res.status(400).json({ error: "A cancelled booking can't hold units. Set it back to Confirmed first." });
  }

  // Whatever set of units this booking will hold on its (possibly new)
  // date, check them against everyone else's rows first for a specific
  // message. The constraint still backs this up in the write below.
  const effectiveUnits = cancelling ? [] : (unitIds ?? existing.units.map((row) => row.unitId));
  if (unitIds !== null) {
    const conflict = await describeConflicts(effectiveUnits, nextDate, id);
    if (conflict) {
      return res.status(409).json({ error: conflict, reason: "unit-conflict" });
    }
  }

  // A plain date move (no explicit unit list alongside it) goes through
  // the same path as the portal's reschedule: for every item the booking
  // holds, one free unit on the new date is locked before anything is
  // released, so it lands on whichever units are free that day, and if
  // any item has none the booking is left exactly as it was.
  if (dateMoved && unitIds === null && !cancelling && data.eventDate) {
    const moveTo = data.eventDate;
    try {
      await rescheduleBooking(id, { date: moveTo }, () => `Rescheduled to ${formatDay(moveTo)} from the admin.`);
    } catch (err) {
      if (err instanceof NoFreeUnit) {
        return res.status(409).json({ error: noFreeUnitMessage(err.itemName, moveTo), reason: "unavailable" });
      }
      if (err instanceof NoCrewFree) {
        return res.status(409).json({ error: noCrewMessage(err.itemName, err.skill, moveTo), reason: "unavailable" });
      }
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: RACE_CONFLICT, reason: "unavailable" });
      }
      throw err;
    }
    delete data.eventDate;
  }

  const ops = [];
  if (cancelling) {
    ops.push(releaseUnits(prisma, id));
    // Its gigs are cancelled with it, so no crew need is left dangling.
    ops.push(prisma.gig.updateMany({ where: { bookingId: id, status: { not: "Cancelled" } }, data: { status: "Cancelled" } }));
  } else if (unitIds !== null) {
    ops.push(prisma.bookingUnit.deleteMany({ where: { bookingId: id } }));
    if (unitIds.length > 0) {
      ops.push(prisma.bookingUnit.createMany({ data: unitIds.map((unitId) => ({ bookingId: id, unitId, eventDate: nextDate })) }));
    }
  }

  try {
    if (ops.length > 0 || Object.keys(data).length > 0) {
      await prisma.$transaction([...ops, prisma.booking.update({ where: { id }, data })]);
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: RACE_CONFLICT, reason: "unit-conflict" });
    }
    throw err;
  }

  const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, include: WITH_UNITS });
  res.json(serialize(booking));
});

async function findOwn(id: string) {
  const account = await getDefaultAccount();
  return { account, booking: await prisma.booking.findFirst({ where: { id, accountId: account.id }, select: { id: true } }) };
}

async function sendBooking(res: Response, id: string) {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, include: WITH_UNITS });
  res.json(serialize(booking));
}

// Adds one unit of an item for the booking's date. Which unit is decided
// by the lock, the same way a direct booking gets one.
router.post("/:id/units", async (req, res) => {
  const id = String(req.params.id);
  const { account, booking } = await findOwn(id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  const itemId = (req.body ?? {}).itemId;
  const item =
    typeof itemId === "string"
      ? await prisma.item.findFirst({
          where: { id: itemId, accountId: account.id },
          select: { id: true, name: true, price: true, skills: true, _count: { select: { units: true } } },
        })
      : null;
  if (!item) return res.status(404).json({ error: "item not found" });

  try {
    // A unit if the item has units, a gig per skill if it has skills,
    // both if both, each locked the way a direct booking locks it.
    await addBookingItem(id, { id: item.id, name: item.name, price: item.price, skills: item.skills, unitCount: item._count.units });
  } catch (err) {
    if (err instanceof NoFreeUnit || err instanceof NoCrewFree) {
      const date = (await prisma.booking.findUniqueOrThrow({ where: { id }, select: { eventDate: true } })).eventDate;
      const message = err instanceof NoFreeUnit ? noFreeUnitMessage(item.name, date) : noCrewMessage(err.itemName, err.skill, date);
      return res.status(409).json({ error: message, reason: "unavailable" });
    }
    if (err instanceof BookingEditError) return res.status(400).json({ error: err.message });
    if (isUniqueViolation(err)) return res.status(409).json({ error: RACE_CONFLICT, reason: "unavailable" });
    throw err;
  }
  await sendBooking(res, id);
});

router.delete("/:id/units/:unitId", async (req, res) => {
  const id = String(req.params.id);
  const { booking } = await findOwn(id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  try {
    await removeBookingUnit(id, String(req.params.unitId));
  } catch (err) {
    if (err instanceof BookingEditError) return res.status(404).json({ error: err.message });
    throw err;
  }
  await sendBooking(res, id);
});

router.delete("/:id/gigs/:gigId", async (req, res) => {
  const id = String(req.params.id);
  const { booking } = await findOwn(id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  try {
    await removeBookingGig(id, String(req.params.gigId));
  } catch (err) {
    if (err instanceof BookingEditError) return res.status(404).json({ error: err.message });
    throw err;
  }
  await sendBooking(res, id);
});

// Replaces the add-on choices for one item on the booking.
router.put("/:id/addons", async (req, res) => {
  const id = String(req.params.id);
  const { account, booking } = await findOwn(id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  const { itemId, addonIds } = (req.body ?? {}) as { itemId?: unknown; addonIds?: unknown };
  if (!Array.isArray(addonIds) || !addonIds.every((a): a is string => typeof a === "string" && a !== "")) {
    return res.status(400).json({ error: "addonIds must be a list of addon ids" });
  }
  const item =
    typeof itemId === "string"
      ? await prisma.item.findFirst({ where: { id: itemId, accountId: account.id }, select: { id: true, name: true } })
      : null;
  if (!item) return res.status(404).json({ error: "item not found" });
  try {
    await setBookingItemAddons(id, item, [...new Set(addonIds)]);
  } catch (err) {
    if (err instanceof AddonSelectionError) return res.status(400).json({ error: err.message, reason: err.reason });
    if (err instanceof BookingEditError) return res.status(400).json({ error: err.message });
    throw err;
  }
  await sendBooking(res, id);
});

export default router;
