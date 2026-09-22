import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { SKILLS, isSkill } from "../skills.js";
import { normalizeText } from "../validate.js";

const MAX_NAME_LENGTH = 120;
const MAX_CONTACT_LENGTH = 120;
const MAX_NOTES_LENGTH = 2000;

const router = Router();

const ORDER = [{ active: "desc" as const }, { name: "asc" as const }];

type Fields = { name?: string; phone?: string | null; email?: string | null; skills?: string[]; active?: boolean; notes?: string | null };

// Reads and checks the editable fields present in a body. Returns a
// message on the first problem. `creating` makes name required.
function readFields(body: Record<string, unknown>, creating: boolean): Fields | string {
  const data: Fields = {};
  if ("name" in body || creating) {
    const name = normalizeText(body.name);
    if (!name || name.length > MAX_NAME_LENGTH) return `name is required, up to ${MAX_NAME_LENGTH} characters`;
    data.name = name;
  }
  for (const field of ["phone", "email"] as const) {
    if (!(field in body)) continue;
    const text = normalizeText(body[field]);
    if (text !== null && text.length > MAX_CONTACT_LENGTH) return `${field} must be up to ${MAX_CONTACT_LENGTH} characters`;
    data[field] = text;
  }
  if ("skills" in body) {
    const skills = body.skills;
    if (!Array.isArray(skills) || !skills.every(isSkill)) {
      return `skills must be a list from: ${SKILLS.join(", ")}`;
    }
    data.skills = [...new Set(skills)];
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") return "active must be true or false";
    data.active = body.active;
  }
  if ("notes" in body) {
    const notes = normalizeText(body.notes);
    if (notes !== null && notes.length > MAX_NOTES_LENGTH) return `notes must be up to ${MAX_NOTES_LENGTH} characters`;
    data.notes = notes;
  }
  return data;
}

// The fixed skill list, so the admin's form and the storefront never have
// to hard-code it apart from the server.
router.get("/skills", (_req, res) => {
  res.json(SKILLS);
});

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json(await prisma.crewMember.findMany({ where: { accountId: account.id }, orderBy: ORDER }));
});

router.post("/", async (req, res) => {
  const fields = readFields((req.body ?? {}) as Record<string, unknown>, true);
  if (typeof fields === "string") return res.status(400).json({ error: fields });
  const account = await getDefaultAccount();
  const member = await prisma.crewMember.create({
    data: {
      accountId: account.id,
      name: fields.name as string,
      phone: fields.phone ?? null,
      email: fields.email ?? null,
      skills: fields.skills ?? [],
      active: fields.active ?? true,
      notes: fields.notes ?? null,
    },
  });
  res.status(201).json(member);
});

// Deactivating is the way to retire someone: active false keeps the row,
// the gigs they filled and the offers they answered, and just stops them
// being offered anything new. There is no delete.
router.patch("/:id", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.crewMember.findFirst({ where: { id, accountId: account.id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: "crew member not found" });
  const fields = readFields((req.body ?? {}) as Record<string, unknown>, false);
  if (typeof fields === "string") return res.status(400).json({ error: fields });
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: "no editable fields provided" });
  res.json(await prisma.crewMember.update({ where: { id }, data: fields }));
});

export default router;
