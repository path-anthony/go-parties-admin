import { prisma } from "./db.js";

export const MAX_STATUS_NAME_LENGTH = 40;

export function normalizeStatusName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name !== "" && name.length <= MAX_STATUS_NAME_LENGTH ? name : null;
}

// New leads, whatever their source, land in the first column.
export async function getDefaultStatus(accountId: string): Promise<string> {
  const first = await prisma.leadStatus.findFirst({ where: { accountId }, orderBy: { position: "asc" } });
  if (!first) throw new Error("No lead columns exist for this account");
  return first.name;
}

export async function statusExists(accountId: string, name: unknown): Promise<boolean> {
  if (typeof name !== "string") return false;
  const row = await prisma.leadStatus.findUnique({ where: { accountId_name: { accountId, name } } });
  return row !== null;
}
