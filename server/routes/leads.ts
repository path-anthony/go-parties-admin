import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const LEAD_STATUSES = ["New", "Contacted", "Booked", "Lost"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

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
    orderBy: { createdAt: "desc" },
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

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};

  if (!isStatus(status)) {
    return res.status(400).json({ error: `status must be one of ${LEAD_STATUSES.join(", ")}` });
  }

  const account = await getDefaultAccount();
  const existing = await prisma.lead.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "lead not found" });
  }

  const lead = await prisma.lead.update({ where: { id }, data: { status } });
  res.json(lead);
});

export default router;
