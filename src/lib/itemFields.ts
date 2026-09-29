// The controlled values for Item fields that used to be free text. Shared
// by the admin screens and the API so the two can't drift apart.

// "Billed per" is how the price reads to a customer. These five are the
// dropdown; anything else is "Other", a short label and not a sentence.
export const BILLED_PER_OPTIONS = ["Per day", "Per hour", "Per event", "Per weekend", "Flat rate"] as const;
export const MAX_BILLED_PER_OTHER = 30;

// The dropdown option a stored value corresponds to, ignoring case, or
// null when it is an "Other" (or empty) value.
export function billedPerOption(value: string | null | undefined): (typeof BILLED_PER_OPTIONS)[number] | null {
  const key = (value ?? "").trim().toLowerCase();
  return BILLED_PER_OPTIONS.find((option) => option.toLowerCase() === key) ?? null;
}

// Where an item comes from. Admin only.
export const ITEM_SOURCES = ["Owned", "Partner-sourced"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];
