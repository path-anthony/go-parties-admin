import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { MAX_STATUS_NAME_LENGTH, normalizeStatusName } from "../leadStatuses.js";

const router = Router();

const ORDER = { position: "asc" as const };

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const statuses = await prisma.leadStatus.findMany({ where: { accountId: account.id }, orderBy: ORDER });
  res.json(statuses);
});

router.post("/", async (req, res) => {
  const name = normalizeStatusName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: `name is required (up to ${MAX_STATUS_NAME_LENGTH} characters)` });
  }

  const account = await getDefaultAccount();
  const duplicate = await prisma.leadStatus.findUnique({ where: { accountId_name: { accountId: account.id, name } } });
  if (duplicate) {
    return res.status(409).json({ error: `A column named "${name}" already exists` });
  }

  const last = await prisma.leadStatus.findFirst({ where: { accountId: account.id }, orderBy: { position: "desc" } });
  const status = await prisma.leadStatus.create({
    data: { accountId: account.id, name, position: last ? last.position + 1 : 0 },
  });
  res.status(201).json(status);
});

// Registered before /:id so "reorder" is never read as an id.
router.patch("/reorder", async (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string") || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "ids must be an array of unique column ids" });
  }

  const account = await getDefaultAccount();
  const existing = await prisma.leadStatus.findMany({ where: { accountId: account.id }, select: { id: true } });
  const existingIds = new Set(existing.map((row) => row.id));
  if (ids.length !== existingIds.size || !ids.every((id) => existingIds.has(id))) {
    return res.status(400).json({ error: "ids must be every column on this account, each exactly once" });
  }

  await prisma.$transaction(
    ids.map((id, position) => prisma.leadStatus.update({ where: { id }, data: { position } })),
  );
  const statuses = await prisma.leadStatus.findMany({ where: { accountId: account.id }, orderBy: ORDER });
  res.json(statuses);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const name = normalizeStatusName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: `name is required (up to ${MAX_STATUS_NAME_LENGTH} characters)` });
  }

  const account = await getDefaultAccount();
  const existing = await prisma.leadStatus.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "column not found" });
  }
  if (existing.name === name) {
    return res.json(existing);
  }
  const duplicate = await prisma.leadStatus.findUnique({ where: { accountId_name: { accountId: account.id, name } } });
  if (duplicate) {
    return res.status(409).json({ error: `A column named "${name}" already exists` });
  }

  // leads.status is a foreign key onto this name with ON UPDATE CASCADE, so
  // the database moves every lead in the column along with the rename.
  const status = await prisma.leadStatus.update({ where: { id }, data: { name } });
  res.json(status);
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const account = await getDefaultAccount();
  const existing = await prisma.leadStatus.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "column not found" });
  }

  const inColumn = await prisma.lead.count({ where: { accountId: account.id, status: existing.name } });
  if (inColumn > 0) {
    return res.status(409).json({
      error: `"${existing.name}" still has ${inColumn} ${inColumn === 1 ? "lead" : "leads"}. Move them to another column first.`,
    });
  }
  const total = await prisma.leadStatus.count({ where: { accountId: account.id } });
  if (total <= 1) {
    return res.status(409).json({ error: "The board needs at least one column. Add another before deleting this one." });
  }

  await prisma.leadStatus.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
