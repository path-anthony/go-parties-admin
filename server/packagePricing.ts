// Block A8. How a package is priced: one bundle price ("fixed"), or a
// price per guest on a count the customer picks ("per_guest"), with an
// optional flat base and a guest range. The tier call and the hold both
// price through packagePrice, so the quote and the booking agree.

export const PRICING_MODES = ["fixed", "per_guest"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const MAX_GUEST_COUNT = 5000;

export type PackagePricing = { price: unknown; pricingMode: string; basePrice: unknown; minGuests: number | null; maxGuests: number | null };

export class GuestCountError extends Error {
  reason: "guest-count-required" | "guest-count-range" | "guest-count-invalid";
  constructor(reason: GuestCountError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export const isPerGuest = (pkg: { pricingMode: string }) => pkg.pricingMode === "per_guest";

// The whole-dollar range sentence the storefront shows.
export function guestRangeSentence(pkg: { minGuests: number | null; maxGuests: number | null }): string {
  const min = pkg.minGuests ?? 1;
  return pkg.maxGuests === null ? `This package is for ${min} or more guests.` : `This package is for ${min} to ${pkg.maxGuests} guests.`;
}

// The package's price for this cart in dollars. A fixed package ignores
// the count; a per-guest one needs it inside the range.
export function packagePrice(pkg: PackagePricing, guestCount: number | null): number {
  if (!isPerGuest(pkg)) return Number(pkg.price);
  if (guestCount === null) throw new GuestCountError("guest-count-required", "Tell us how many guests, so we can price this package.");
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUEST_COUNT) throw new GuestCountError("guest-count-invalid", `guestCount must be a whole number from 1 to ${MAX_GUEST_COUNT}`);
  const min = pkg.minGuests ?? 1;
  if (guestCount < min || (pkg.maxGuests !== null && guestCount > pkg.maxGuests)) throw new GuestCountError("guest-count-range", guestRangeSentence(pkg));
  return Math.round((Number(pkg.basePrice ?? 0) + Number(pkg.price) * guestCount) * 100) / 100;
}

// The request's guestCount as sent: absent or null is null; anything else
// must be a whole number in range. Returns a message when it is not.
export function parseGuestCount(value: unknown): number | null | string {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_GUEST_COUNT) return `guestCount must be a whole number from 1 to ${MAX_GUEST_COUNT}`;
  return value;
}
