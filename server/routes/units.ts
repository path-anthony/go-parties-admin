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

  const unit = await prisma.unit.create({ data: { itemId: item.id, label: labelText, status: status ?? "Available" } });
  res.status(201).json(unit);
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
