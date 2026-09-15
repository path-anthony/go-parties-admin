import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { getDefaultStatus, statusExists } from "../leadStatuses.js";

const EDITABLE_TEXT_FIELDS = ["customerName", "contact", "occasion", "notes"] as const;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_ACTIVITY_LENGTH = 2000;

// sortOrder first, then newest first among ties. Rows that have never been
// dragged all sit at 0, so an untouched column is simply newest first.
const COLUMN_ORDER = [{ sortOrder: "asc" as const }, { createdAt: "desc" as const }];

const router = Router();

const INVALID = Symbol("invalid");

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

// Trimmed, non-empty, deduplicated, capped in count and length.
function normalizeTags(value: unknown): string[] | typeof INVALID {
  if (!Array.isArray(value) || !value.every((tag): tag is string => typeof tag === "string")) return INVALID;
  const tags = [...new Set(value.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
  if (tags.length > MAX_TAGS || tags.some((tag) => tag.length > MAX_TAG_LENGTH)) return INVALID;
  return tags;
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

  const account = await getDefaultAccount();
  if (status !== undefined && !(await statusExists(account.id, status))) {
    return res.status(400).json({ error: "status must be an existing column" });
  }

  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      source: "manual",
      status: status ?? (await getDefaultStatus(account.id)),
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

  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id): id is string => typeof id === "string") ||
    new Set(ids).size !== ids.length
  ) {
    return res.status(400).json({ error: "ids must be a non-empty array of unique lead ids" });
  }

  const account = await getDefaultAccount();
  if (!(await statusExists(account.id, status))) {
    return res.status(400).json({ error: "status must be an existing column" });
  }
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
    status?: string;
    sortOrder?: number;
    tags?: string[];
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
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (tags === INVALID) {
      return res.status(400).json({
        error: `tags must be an array of up to ${MAX_TAGS} strings, each up to ${MAX_TAG_LENGTH} characters`,
      });
    }
    data.tags = tags;
  }
  if ("status" in body) {
    if (!(await statusExists(account.id, body.status))) {
      return res.status(400).json({ error: "status must be an existing column" });
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

router.get("/:id/activity", async (req, res) => {
  const { id } = req.params;
  const account = await getDefaultAccount();
  const lead = await prisma.lead.findFirst({ where: { id, accountId: account.id }, select: { id: true } });
  if (!lead) {
    return res.status(404).json({ error: "lead not found" });
  }
  const entries = await prisma.leadActivity.findMany({ where: { leadId: id }, orderBy: { createdAt: "desc" } });
  res.json(entries);
});

// Append-only: there is deliberately no PATCH or DELETE for entries.
router.post("/:id/activity", async (req, res) => {
  const { id } = req.params;
  const text = normalizeText(req.body?.text);
  if (!text || text.length > MAX_ACTIVITY_LENGTH) {
    return res.status(400).json({ error: `text is required (up to ${MAX_ACTIVITY_LENGTH} characters)` });
  }

  const account = await getDefaultAccount();
  const lead = await prisma.lead.findFirst({ where: { id, accountId: account.id }, select: { id: true } });
  if (!lead) {
    return res.status(404).json({ error: "lead not found" });
  }

  const entry = await prisma.leadActivity.create({ data: { leadId: id, text } });
  res.status(201).json(entry);
});

export default router;
