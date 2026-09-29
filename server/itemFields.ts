import { BILLED_PER_OPTIONS, MAX_BILLED_PER_OTHER, billedPerOption } from "../src/lib/itemFields.js";

// Billed per is a choice from a short list, or a short "Other" label. A
// match on the list (any case) is stored with the list's spelling; any
// other text has to fit in a label, not a sentence. Returns the value to
// store (null for blank) or a message saying what was wrong.
export function normalizeBilledPer(value: unknown): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: "priceUnit must be text" };
  const text = value.trim();
  if (text === "") return { value: null };
  const option = billedPerOption(text);
  if (option) return { value: option };
  if (text.length > MAX_BILLED_PER_OTHER) {
    return {
      error: `priceUnit is a short label, ${MAX_BILLED_PER_OTHER} characters at most. Pick ${BILLED_PER_OPTIONS.join(", ")}, or a short Other. Longer notes belong in notes.`,
    };
  }
  return { value: text };
}
