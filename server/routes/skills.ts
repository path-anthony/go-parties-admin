import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { normalizeText } from "../validate.js";

const MAX_NAME_LENGTH = 60;

const router = Router();

const ORDER = [{ position: "asc" as const }, { createdAt: "asc" as const }];

function cleanName(value: unknown): string | null {
  const name = normalizeText(value);
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

// How many items and crew members list a skill, by name. Gigs are not
// counted: they are records of past needs and follow a rename, but they
// never block a delete.
async function usageOf(accountId: string, name: string) {
  const [items, crew] = await Promise.all([
    prisma.item.count({ where: { accountId, skills: { has: name } } }),
    prisma.crewMember.count({ where: { accountId, skills: { has: name } } }),
  ]);
  return { items, crew };
}

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const rows = await prisma.skill.findMany({ where: { accountId: account.id }, orderBy: ORDER });
  const usage = await Promise.all(rows.map((r) => usageOf(account.id, r.name)));
  res.json(rows.map((r, i) => ({ ...r, usedByItems: usage[i].items, usedByCrew: usage[i].crew })));
});

router.post("/", async (req, res) => {
  const name = cleanName((req.body ?? {}).name);
  if (!name) return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
  const account = await getDefaultAccount();
  const clash = await prisma.skill.findFirst({ where: { accountId: account.id, name: { equals: name, mode: "insensitive" } } });
  if (clash) return res.status(409).json({ error: `There is already a skill called ${clash.name}` });
  const last = await prisma.skill.aggregate({ where: { accountId: account.id }, _max: { position: true } });
  const row = await prisma.skill.create({ data: { accountId: account.id, name, position: (last._max.position ?? -1) + 1 } });
  res.status(201).json({ ...row, usedByItems: 0, usedByCrew: 0 });
});

// A rename rewrites the name everywhere it is held as text, in one
// transaction: every item's and crew member's skills list, and every gig.
router.patch("/:id", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.skill.findFirst({ where: { id, accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "skill not found" });
  const name = cleanName((req.body ?? {}).name);
  if (!name) return res.status(400).json({ error: `name is required, up to ${MAX_NAME_LENGTH} characters` });
  if (name === existing.name) {
    const usage = await usageOf(account.id, name);
    return res.json({ ...existing, usedByItems: usage.items, usedByCrew: usage.crew });
  }
  const clash = await prisma.skill.findFirst({ where: { accountId: account.id, id: { not: id }, name: { equals: name, mode: "insensitive" } } });
  if (clash) return res.status(409).json({ error: `There is already a skill called ${clash.name}` });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.skill.update({ where: { id }, data: { name } });
    await tx.$executeRaw`UPDATE items SET skills = array_replace(skills, ${existing.name}, ${name}) WHERE account_id = ${account.id} AND ${existing.name} = ANY(skills)`;
    await tx.$executeRaw`UPDATE crew_members SET skills = array_replace(skills, ${existing.name}, ${name}) WHERE account_id = ${account.id} AND ${existing.name} = ANY(skills)`;
    await tx.gig.updateMany({ where: { accountId: account.id, skill: existing.name }, data: { skill: name } });
    return row;
  });
  const usage = await usageOf(account.id, name);
  res.json({ ...updated, usedByItems: usage.items, usedByCrew: usage.crew });
});

// Refused while any item or crew member still lists the skill; the
// message says how many of each so the admin knows what to untag.
router.delete("/:id", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.skill.findFirst({ where: { id, accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "skill not found" });
  const usage = await usageOf(account.id, existing.name);
  if (usage.items > 0 || usage.crew > 0) {
    const parts = [
      usage.items > 0 ? `${usage.items} ${usage.items === 1 ? "item" : "items"}` : null,
      usage.crew > 0 ? `${usage.crew} crew ${usage.crew === 1 ? "member" : "members"}` : null,
    ].filter((p): p is string => p !== null);
    return res.status(409).json({
      error: `${existing.name} is still used by ${parts.join(" and ")}. Remove it from them first, then delete it.`,
      reason: "in-use",
      usedByItems: usage.items,
      usedByCrew: usage.crew,
    });
  }
  await prisma.skill.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
