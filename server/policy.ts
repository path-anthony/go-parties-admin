import { prisma } from "./db.js";

// The cancellation and retainer policy text, versioned. A save never edits
// a row; it adds the next version, so an Agreement can always point at the
// exact text the customer saw. Version 1 is created empty the first time
// anything asks, so there is always a current version to point at.

export const MAX_POLICY_LENGTH = 20_000;

export type PolicyVersionRow = { id: string; version: number; text: string; createdAt: Date };

export async function currentPolicy(accountId: string): Promise<PolicyVersionRow> {
  const latest = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (latest) return latest;
  try {
    return await prisma.policyVersion.create({ data: { accountId, version: 1, text: "" } });
  } catch (err) {
    // Two first requests raced; the unique (account, version) decided.
    if ((err as { code?: unknown }).code === "P2002") {
      return prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
    }
    throw err;
  }
}

export async function listPolicyVersions(accountId: string) {
  await currentPolicy(accountId);
  return prisma.policyVersion.findMany({
    where: { accountId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, text: true, createdAt: true, _count: { select: { agreements: true } } },
  });
}

// Adds the next version. Saving the text that is already current is a
// no-op, so opening the editor and pressing Save doesn't mint a version.
export async function savePolicy(accountId: string, text: string): Promise<{ created: boolean; policy: PolicyVersionRow }> {
  const current = await currentPolicy(accountId);
  if (current.text === text) return { created: false, policy: current };
  const policy = await prisma.policyVersion.create({ data: { accountId, version: current.version + 1, text } });
  return { created: true, policy };
}

// What the storefront may show: null until there is text to show.
export function publicPolicy(policy: PolicyVersionRow) {
  if (policy.text.trim() === "") return null;
  return { id: policy.id, version: policy.version, text: policy.text, updatedAt: policy.createdAt.toISOString() };
}

// Block F1. The policy text with its {{numbers}} filled in, for places where
// the admin hands a customer the wording to read and accept (the cancellation
// terms, the pay link). The storefront fills the same tokens itself from
// GET /api/settings/public for the policy it shows at checkout; this is the
// same rule: a token is the name of a number setting, case does not matter,
// and a token that names nothing is left as written.
const POLICY_NUMBERS = ["depositPercentage", "cancellationWindowDays", "minBookingNoticeHours", "rescheduleFeePercent", "balanceDueDays", "requestResponseDays"] as const;
export function fillPolicyText(text: string, settings: Partial<Record<(typeof POLICY_NUMBERS)[number], number>>): string {
  const byName = new Map<string, number>();
  for (const k of POLICY_NUMBERS) {
    const v = settings[k];
    if (typeof v === "number" && Number.isFinite(v)) byName.set(k.toLowerCase(), v);
  }
  return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (whole, name: string) => {
    const v = byName.get(name.toLowerCase());
    return v === undefined ? whole : String(v);
  });
}
