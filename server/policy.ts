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

// Block F1, widened in Block FIX1. The policy text with its {{numbers}}
// filled in from Settings at the moment it is shown, for every place a
// customer reads or accepts it: checkout, the pay link, the cancellation
// terms, both contract layouts. A token is the name of a number setting, in
// camelCase or snake_case, case ignored; {{retainerPercent}} and
// {{depositPercentage}} are the same number. A token that names nothing is
// left as written. What a customer already accepted is stored filled in and
// never filled again.
type PolicyNumbers = Partial<Record<"depositPercentage" | "cancellationWindowDays" | "minBookingNoticeHours" | "rescheduleFeePercent" | "balanceDueDays" | "requestResponseDays", number>>;
export function policyTokenValues(settings: PolicyNumbers): Map<string, number> {
  const named: [string, number | undefined][] = [
    ["depositPercentage", settings.depositPercentage],
    ["retainerPercent", settings.depositPercentage],
    ["retainerPercentage", settings.depositPercentage],
    ["cancellationWindowDays", settings.cancellationWindowDays],
    ["minBookingNoticeHours", settings.minBookingNoticeHours],
    ["rescheduleFeePercent", settings.rescheduleFeePercent],
    ["balanceDueDays", settings.balanceDueDays],
    ["requestResponseDays", settings.requestResponseDays],
  ];
  const out = new Map<string, number>();
  for (const [name, v] of named) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.set(name.toLowerCase(), v);
    out.set(name.replace(/[A-Z]/g, (c) => `_${c}`).toLowerCase(), v);
  }
  return out;
}
export function fillPolicyText(text: string, settings: PolicyNumbers): string {
  const byName = policyTokenValues(settings);
  return text.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (whole, name: string) => {
    const v = byName.get(name.toLowerCase());
    return v === undefined ? whole : String(v);
  });
}

// Block FIX1. Where a policy's wording still carries a number or a word that
// should come from Settings. For staff, on the policy screen and in the
// report. Pure.
export function hardcodedInPolicy(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b\d{1,3}(\.\d+)?\s?%/g)) found.add(m[0].replace(/\s/g, ""));
  for (const m of text.matchAll(/\b(\d{1,3})\s+(business\s+)?(days?|hours?)\b/gi)) found.add(m[0]);
  if (/\bdeposits?\b/i.test(text)) found.add('"deposit"');
  return [...found];
}

// Block FIX1. A suggested new version: in every sentence that is about the
// retainer, a deposit, the balance or cancelling, a percent becomes
// {{retainerPercent}}% and a day count that matches a setting becomes that
// setting's token; "deposit" becomes "retainer" everywhere. Shown to staff as
// a draft to read before it is ever used. Pure.
export function suggestPolicyDraft(text: string, settings: { cancellationWindowDays: number; balanceDueDays: number; rescheduleFeePercent?: number }): string {
  // Paragraph by paragraph: a heading line like "Remaining balance." and the
  // sentence under it belong together.
  const sentences = text.split(/(\n\s*\n)/);
  const out = sentences.map((part) => {
    if (/^\s+$/.test(part)) return part;
    let p = part;
    const money = /\b(retainer|deposit|hold your date|holds? (the|your) date|booking fee)/i.test(p);
    const reschedule = /\breschedul/i.test(p);
    if (reschedule && settings.rescheduleFeePercent !== undefined) p = p.replace(/\b(\d{1,3})\s?%/g, (w, n) => (Number(n) === settings.rescheduleFeePercent ? "{{rescheduleFeePercent}}%" : w));
    else if (money) p = p.replace(/\b\d{1,3}\s?%/g, "{{retainerPercent}}%");
    if (/\bcancel/i.test(p)) p = p.replace(/\b(\d{1,3})(\s+)days\b/g, (w, n, sp) => (Number(n) === settings.cancellationWindowDays ? `{{cancellationWindowDays}}${sp}days` : w));
    if (/\bbalance\b/i.test(p)) p = p.replace(/\b(\d{1,3})(\s+)days\b/g, (w, n, sp) => (Number(n) === settings.balanceDueDays ? `{{balanceDueDays}}${sp}days` : w));
    return p;
  });
  return out
    .join("")
    .replace(/\bDeposits\b/g, "Retainers")
    .replace(/\bdeposits\b/g, "retainers")
    .replace(/\bDeposit\b/g, "Retainer")
    .replace(/\bdeposit\b/g, "retainer")
    .replace(/\bDEPOSIT\b/g, "RETAINER");
}
