import { prisma } from "./db.js";

// Skills live in the skills table, managed in Settings. Item.skills,
// CrewMember.skills and Gig.skill hold the names as plain strings, so
// validation is "is this a name in the table for this account".

export async function listSkillNames(accountId: string): Promise<string[]> {
  const rows = await prisma.skill.findMany({ where: { accountId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { name: true } });
  return rows.map((r) => r.name);
}

// Returns the cleaned, de-duplicated list, or a message naming what was
// wrong: not a list, or a name that isn't a skill on this account.
export async function validateSkills(accountId: string, value: unknown): Promise<string[] | string> {
  if (!Array.isArray(value) || !value.every((s): s is string => typeof s === "string")) {
    return "skills must be a list of skill names";
  }
  const known = new Set(await listSkillNames(accountId));
  const unique = [...new Set(value.map((s) => s.trim()).filter((s) => s !== ""))];
  const unknown = unique.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    return `unknown skill${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Add it under Settings first.`;
  }
  return unique;
}

export const GIG_STATUSES = ["Needs Crew", "Offered", "Filled", "Cancelled"] as const;
export const OFFER_STATUSES = ["Sent", "Accepted", "Declined"] as const;
