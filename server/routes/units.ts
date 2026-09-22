import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { isOneOf, normalizeText } from "../validate.js";

const UNIT_STATUSES = ["Available", "Booked", "Maintenance"] as const;

const router = Router();

const ORDER = [{ item: { name: "asc" as const } }, { label: "asc" as const }];

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const units = await prisma.unit.findMany({ where: { item: { accountId: account.id } }, orderBy: ORDER });
  res.json(units);
});

router.post("/", async (req, res) => {
  const { itemId, label, status } = req.body ?? {};

  const labelText = normalizeText(label);
  if (!labelText) {
    return res.status(400).json({ error: "label is required" });
  }
  if (status !== undefined && !isOneOf(UNIT_STATUSES, status)) {
    return res.status(400).json({ error: `status must be one of ${UNIT_STATUSES.join(", ")}` });
  }

  const account = await getDefaultAccount();
  const item = typeof itemId === "string" ? await prisma.item.findFirst({ where: { id: itemId, accountId: account.id } }) : null;
  if (!item) {
    return res.status(400).json({ error: "itemId must be an item on this account" });
  }
  // A service item is a person's time, tracked as crew, never as units.
  if (item.requiredSkill !== null) {
    return res.status(409).json({ error: `${item.name} needs a ${item.requiredSkill}; it's covered by crew, not units.` });
  }

  const unit = await prisma.unit.create({ data: { itemId: item.id, label: labelText, status: status ?? "Available" } });
  res.status(201).json(unit);
});

const MAX_BULK_ITEMS = 100;
const MAX_BULK_QUANTITY = 50;
const MAX_LABEL_LENGTH = 60;

// "Cart #3" means prefix "Cart" numbered from 3; a pattern with no "#n"
// is a prefix numbered from 1. Numbers that an item already uses are
// skipped so a second run doesn't hand out duplicate labels.
function parseLabelPattern(pattern: string): { prefix: string; start: number } {
  const match = /^(.*?)#\s*(\d+)\s*$/.exec(pattern);
  if (match) return { prefix: match[1].trim(), start: Number(match[2]) };
  return { prefix: pattern.trim(), start: 1 };
}

function labelFor(prefix: string, n: number): string {
  return prefix ? `${prefix} #${n}` : `#${n}`;
}

// One action, many items: the same count of units, with the same label
// pattern and status, for every selected item, all in one transaction.
router.post("/bulk", async (req, res) => {
  const { itemIds, labelPattern, quantity, status } = req.body ?? {};

  if (!Array.isArray(itemIds) || itemIds.length === 0 || !itemIds.every((id): id is string => typeof id === "string")) {
    return res.status(400).json({ error: "itemIds must be a non-empty array of item ids" });
  }
  const uniqueItemIds = [...new Set(itemIds)];
  if (uniqueItemIds.length > MAX_BULK_ITEMS) {
    return res.status(400).json({ error: `itemIds can hold at most ${MAX_BULK_ITEMS} items` });
  }
  const pattern = normalizeText(labelPattern);
  if (!pattern || pattern.length > MAX_LABEL_LENGTH) {
    return res.status(400).json({ error: `labelPattern is required (up to ${MAX_LABEL_LENGTH} characters)` });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BULK_QUANTITY) {
    return res.status(400).json({ error: `quantity must be a whole number from 1 to ${MAX_BULK_QUANTITY}` });
  }
  if (status !== undefined && !isOneOf(UNIT_STATUSES, status)) {
    return res.status(400).json({ error: `status must be one of ${UNIT_STATUSES.join(", ")}` });
  }

  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({ where: { id: { in: uniqueItemIds }, accountId: account.id }, select: { id: true, name: true, requiredSkill: true } });
  if (items.length !== uniqueItemIds.length) {
    return res.status(400).json({ error: "itemIds must all be items on this account" });
  }
  const services = items.filter((item) => item.requiredSkill !== null);
  if (services.length > 0) {
    return res.status(409).json({
      error: `${services.map((item) => item.name).join(", ")} ${services.length === 1 ? "is" : "are"} covered by crew, not units. Unselect ${services.length === 1 ? "it" : "them"} first.`,
    });
  }

  const existing = await prisma.unit.findMany({ where: { itemId: { in: uniqueItemIds } }, select: { itemId: true, label: true } });
  const taken = new Map<string, Set<string>>();
  for (const unit of existing) {
    if (!taken.has(unit.itemId)) taken.set(unit.itemId, new Set());
    taken.get(unit.itemId)?.add(unit.label);
  }

  const { prefix, start } = parseLabelPattern(pattern);
  const plan = uniqueItemIds.map((itemId) => {
    const used = taken.get(itemId) ?? new Set<string>();
    const labels: string[] = [];
    for (let n = start; labels.length < quantity; n += 1) {
      const label = labelFor(prefix, n);
      if (!used.has(label)) labels.push(label);
    }
    return { itemId, labels };
  });

  const rows = plan.flatMap(({ itemId, labels }) => labels.map((label) => ({ itemId, label, status: status ?? "Available" })));
  await prisma.$transaction([prisma.unit.createMany({ data: rows })]);

  res.status(201).json({ created: rows.length, items: plan });
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.unit.findFirst({ where: { id, item: { accountId: account.id } } });
  if (!existing) {
    return res.status(404).json({ error: "unit not found" });
  }

  const data: { label?: string; status?: string } = {};
  if ("label" in body) {
    const labelText = normalizeText(body.label);
    if (!labelText) {
      return res.status(400).json({ error: "label is required" });
    }
    data.label = labelText;
  }
  if ("status" in body) {
    if (!isOneOf(UNIT_STATUSES, body.status)) {
      return res.status(400).json({ error: `status must be one of ${UNIT_STATUSES.join(", ")}` });
    }
    data.status = body.status;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const unit = await prisma.unit.update({ where: { id }, data });
  res.json(unit);
});

export default router;
