import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { normalizeText } from "../validate.js";

const MAX_NAME_LENGTH = 80;
const MAX_GROUPS_PER_ITEM = 20;
const MAX_ADDONS_PER_GROUP = 50;
const MAX_DELTA = 100_000;

const router = Router();

const WITH_ADDONS = { addons: { orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }] } };

function normalizeName(value: unknown): string | null {
  const name = normalizeText(value);
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

// Zero and negatives are real values here (a free flavor, a downgrade).
// Blank means zero.
function normalizeDelta(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) > MAX_DELTA) return null;
  return Math.round(num * 100) / 100;
}

async function findGroup(id: string) {
  const account = await getDefaultAccount();
  return prisma.addonGroup.findFirst({ where: { id, item: { accountId: account.id } }, include: WITH_ADDONS });
}

router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = normalizeName(body.name);
  if (!name) {
    return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
  }
  if (body.required !== undefined && typeof body.required !== "boolean") {
    return res.status(400).json({ error: "required must be true or false" });
  }
  const account = await getDefaultAccount();
  const item =
    typeof body.itemId === "string"
      ? await prisma.item.findFirst({ where: { id: body.itemId, accountId: account.id }, select: { id: true } })
      : null;
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }
  const existing = await prisma.addonGroup.findMany({ where: { itemId: item.id }, select: { name: true, position: true } });
  if (existing.length >= MAX_GROUPS_PER_ITEM) {
    return res.status(400).json({ error: `An item can have at most ${MAX_GROUPS_PER_ITEM} add-on groups` });
  }
  if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `This item already has a group called ${name}` });
  }
  const group = await prisma.addonGroup.create({
    data: {
      itemId: item.id,
      name,
      required: body.required === true,
      position: existing.reduce((max, g) => Math.max(max, g.position), -1) + 1,
    },
    include: WITH_ADDONS,
  });
  res.status(201).json(group);
});

router.patch("/:id", async (req, res) => {
  const group = await findGroup(String(req.params.id));
  if (!group) {
    return res.status(404).json({ error: "add-on group not found" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { name?: string; required?: boolean } = {};
  if ("name" in body) {
    const name = normalizeName(body.name);
    if (!name) {
      return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
    }
    const clash = await prisma.addonGroup.findFirst({
      where: { itemId: group.itemId, id: { not: group.id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({ error: `This item already has a group called ${name}` });
    }
    data.name = name;
  }
  if ("required" in body) {
    if (typeof body.required !== "boolean") {
      return res.status(400).json({ error: "required must be true or false" });
    }
    data.required = body.required;
  }
  res.json(await prisma.addonGroup.update({ where: { id: group.id }, data, include: WITH_ADDONS }));
});

// A real delete, options included. Bookings that picked one of them keep
// their own copy of the names and price, so nothing sold is rewritten.
router.delete("/:id", async (req, res) => {
  const group = await findGroup(String(req.params.id));
  if (!group) {
    return res.status(404).json({ error: "add-on group not found" });
  }
  await prisma.addonGroup.delete({ where: { id: group.id } });
  res.json({ ok: true });
});

router.post("/:id/addons", async (req, res) => {
  const group = await findGroup(String(req.params.id));
  if (!group) {
    return res.status(404).json({ error: "add-on group not found" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = normalizeName(body.name);
  if (!name) {
    return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
  }
  const priceDelta = normalizeDelta(body.priceDelta);
  if (priceDelta === null) {
    return res.status(400).json({ error: "priceDelta must be a number; zero and negatives are allowed" });
  }
  if (group.addons.length >= MAX_ADDONS_PER_GROUP) {
    return res.status(400).json({ error: `A group can have at most ${MAX_ADDONS_PER_GROUP} options` });
  }
  if (group.addons.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `${group.name} already has an option called ${name}` });
  }
  await prisma.addon.create({
    data: {
      addonGroupId: group.id,
      name,
      priceDelta,
      position: group.addons.reduce((max, a) => Math.max(max, a.position), -1) + 1,
    },
  });
  res.status(201).json(await findGroup(group.id));
});

router.patch("/:id/addons/:addonId", async (req, res) => {
  const group = await findGroup(String(req.params.id));
  const addon = group?.addons.find((a) => a.id === String(req.params.addonId));
  if (!group || !addon) {
    return res.status(404).json({ error: "option not found" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { name?: string; priceDelta?: number } = {};
  if ("name" in body) {
    const name = normalizeName(body.name);
    if (!name) {
      return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
    }
    if (group.addons.some((a) => a.id !== addon.id && a.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `${group.name} already has an option called ${name}` });
    }
    data.name = name;
  }
  if ("priceDelta" in body) {
    const priceDelta = normalizeDelta(body.priceDelta);
    if (priceDelta === null) {
      return res.status(400).json({ error: "priceDelta must be a number; zero and negatives are allowed" });
    }
    data.priceDelta = priceDelta;
  }
  await prisma.addon.update({ where: { id: addon.id }, data });
  res.json(await findGroup(group.id));
});

router.delete("/:id/addons/:addonId", async (req, res) => {
  const group = await findGroup(String(req.params.id));
  const addon = group?.addons.find((a) => a.id === String(req.params.addonId));
  if (!group || !addon) {
    return res.status(404).json({ error: "option not found" });
  }
  await prisma.addon.delete({ where: { id: addon.id } });
  res.json(await findGroup(group.id));
});

export default router;
