export const INVALID = Symbol("invalid");

export function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Accepts "YYYY-MM-DD", which is what <input type="date"> sends. DATE
// columns are pinned to UTC midnight both ways. Date parsing rolls
// impossible days over (2026-02-31 becomes March 3) instead of failing, so
// the round trip has to match exactly to count as valid.
export function normalizeDate(value: unknown): Date | null | typeof INVALID {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return INVALID;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return INVALID;
  return date;
}

export function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

// Same basic shape the contact-split migration used, so a value sorts the
// same way whether it arrived before or after the split.
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

// A single free-text "phone or email" becomes one side or the other; the
// other side stays null rather than guessed.
export function splitContact(contact: string): { phone: string | null; email: string | null } {
  return looksLikeEmail(contact) ? { phone: null, email: contact } : { phone: contact, email: null };
}
