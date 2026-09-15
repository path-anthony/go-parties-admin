import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const LEAD_STATUSES = ["New", "Contacted", "Booked", "Lost"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

const EDITABLE_TEXT_FIELDS = ["customerName", "contact", "occasion", "notes"] as const;

// sortOrder first, then newest first among ties. Rows that have never been
// dragged all sit at 0, so an untouched column is simply newest first.
const COLUMN_ORDER = [{ sortOrder: "asc" as const }, { createdAt: "desc" as const }];

const router = Router();

const INVALID = Symbol("invalid");

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

// Accepts "YYYY-MM-DD", which is what <input type="date"> sends. The column
// is a plain DATE, so the value is pinned to UTC midnight both ways. Date
// parsing rolls impossible days over (2026-02-31 becomes March 3) instead
// of failing, so the round trip has to match exactly to count as valid.
function normalizeDate(value: unknown): Date | null | typeof INVALID {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return INVALID;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return INVALID;
  return date;
}

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const leads = await prisma.lead.findMany({
    where: { accountId: account.id },
    orderBy: COLUMN_ORDER,
  });
  res.json(leads);
});

router.post("/", async (req, res) => {
  const { customerName, contact, occasion, dateOfInterest, notes, status } = req.body ?? {};

  const name = normalizeText(customerName);
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const contactText = normalizeText(contact);
  if (!contactText) {
    return res.status(400).json({ error: "contact is required" });
  }
  const date = normalizeDate(dateOfInterest);
  if (date === INVALID) {
    return res.status(400).json({ error: "dateOfInterest must be a valid YYYY-MM-DD date" });
  }
  if (status !== undefined && !isStatus(status)) {
    return res.status(400).json({ error: `status must be one of ${LEAD_STATUSES.join(", ")}` });
  }

  const account = await getDefaultAccount();
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      source: "manual",
      status: status ?? "New",
      customerName: name,
      contact: contactText,
      occasion: normalizeText(occasion),
      dateOfInterest: date,
      notes: normalizeText(notes),
    },
  });

  res.status(201).json(lead);
});

// One call per drop on the board: the client sends the target column's ids
// in display order. Every id gets that status (which is how a drag between
// columns changes status) and its index as sortOrder. The source column of
// a cross-column move is left with a gap in its numbering, which keeps its
// relative order intact, so it doesn't need a second call. Registered
// before /:id so "reorder" is never read as a lead id.
router.patch("/reorder", async (req, res) => {
  const { status, ids } = req.body ?? {};

  if (!isStatus(status)) {
    return res.status(400).json({ error: `status must be one of ${LEAD_STATUSES.join(", ")}` });
  }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id): id is string => typeof id === "string") ||
    new Set(ids).size !== ids.length
  ) {
    return res.status(400).json({ error: "ids must be a non-empty array of unique lead ids" });
  }

  const account = await getDefaultAccount();
  const owned = await prisma.lead.count({ where: { id: { in: ids }, accountId: account.id } });
  if (owned !== ids.length) {
    return res.status(400).json({ error: "ids must all be leads on this account" });
  }

  await prisma.$transaction(
    ids.map((id, index) => prisma.lead.update({ where: { id }, data: { status, sortOrder: index } })),
  );

  const leads = await prisma.lead.findMany({
    where: { accountId: account.id, status },
    orderBy: COLUMN_ORDER,
  });
  res.json(leads);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.lead.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "lead not found" });
  }

  const data: {
    customerName?: string | null;
    contact?: string | null;
    occasion?: string | null;
    notes?: string | null;
    dateOfInterest?: Date | null;
    status?: LeadStatus;
    sortOrder?: number;
  } = {};

  for (const field of EDITABLE_TEXT_FIELDS) {
    if (field in body) data[field] = normalizeText(body[field]);
  }
  if ("dateOfInterest" in body) {
    const date = normalizeDate(body.dateOfInterest);
    if (date === INVALID) {
      return res.status(400).json({ error: "dateOfInterest must be a valid YYYY-MM-DD date" });
    }
    data.dateOfInterest = date;
  }
  if ("status" in body) {
    if (!isStatus(body.status)) {
      return res.status(400).json({ error: `status must be one of ${LEAD_STATUSES.join(", ")}` });
    }
    data.status = body.status;
    // A status change that didn't come from a drag lands in the new
    // column's top group rather than keeping a position from the old one.
    if (body.status !== existing.status) data.sortOrder = 0;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const lead = await prisma.lead.update({ where: { id }, data });
  res.json(lead);
});

export default router;
