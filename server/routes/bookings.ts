import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { INVALID, isOneOf, normalizeDate, normalizeText } from "../validate.js";

const BOOKING_STATUSES = ["Confirmed", "Completed", "Cancelled"] as const;

const router = Router();

const WITH_UNITS = { units: { select: { unitId: true } } };
const ORDER = [{ eventDate: "asc" as const }, { createdAt: "asc" as const }];

// The join rows are an implementation detail; clients see a flat unitIds.
function serialize<T extends { units: { unitId: string }[] }>(booking: T) {
  const { units, ...rest } = booking;
  return { ...rest, unitIds: units.map((row) => row.unitId) };
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

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const bookings = await prisma.booking.findMany({ where: { accountId: account.id }, include: WITH_UNITS, orderBy: ORDER });
  res.json(bookings.map(serialize));
});

router.post("/", async (req, res) => {
  const { leadId, eventDate, customerName, customerContact, status, unitIds } = req.body ?? {};

  const name = normalizeText(customerName);
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const contact = normalizeText(customerContact);
  if (!contact) {
    return res.status(400).json({ error: "customerContact is required" });
  }
  const date = normalizeDate(eventDate);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
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

  const booking = await prisma.booking.create({
    data: {
      accountId: account.id,
      leadId: resolvedLead,
      eventDate: date,
      customerName: name,
      customerContact: contact,
      status: status ?? "Confirmed",
      units: { create: resolvedUnits.map((unitId) => ({ unitId })) },
    },
    include: WITH_UNITS,
  });
  res.status(201).json(serialize(booking));
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.booking.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "booking not found" });
  }

  const data: {
    leadId?: string | null;
    eventDate?: Date;
    customerName?: string;
    customerContact?: string;
    status?: string;
  } = {};

  if ("customerName" in body) {
    const name = normalizeText(body.customerName);
    if (!name) return res.status(400).json({ error: "customerName is required" });
    data.customerName = name;
  }
  if ("customerContact" in body) {
    const contact = normalizeText(body.customerContact);
    if (!contact) return res.status(400).json({ error: "customerContact is required" });
    data.customerContact = contact;
  }
  if ("eventDate" in body) {
    const date = normalizeDate(body.eventDate);
    if (date === null || date === INVALID) {
      return res.status(400).json({ error: "eventDate must be a valid YYYY-MM-DD date" });
    }
    data.eventDate = date;
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

  // unitIds replaces the whole set, so the join rows are rebuilt in the
  // same transaction as the field update.
  const ops = [];
  if (unitIds !== null) {
    ops.push(prisma.bookingUnit.deleteMany({ where: { bookingId: id } }));
    if (unitIds.length > 0) {
      ops.push(prisma.bookingUnit.createMany({ data: unitIds.map((unitId) => ({ bookingId: id, unitId })) }));
    }
  }
  await prisma.$transaction([...ops, prisma.booking.update({ where: { id }, data })]);

  const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, include: WITH_UNITS });
  res.json(serialize(booking));
});

export default router;
