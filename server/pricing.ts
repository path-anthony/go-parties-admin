import { GuestCountError, packagePrice, type PackagePricing } from "./packagePricing.js";

// Block FIX1. The one pricing rule. Every total the app works out (the tier
// check and its review threshold, the hold, the review request, the quote
// and both contract layouts, the money on an admin booking, Ask GO's budget
// check, and so the Stripe retainer, balance and pay links that read the
// booking's total) is the sum this file gives. Pure: callers load the rows.
//
//   An item billed "per guest" costs price x guest count. The guest count is
//   required whenever the cart has one (400 guest-count-required).
//   Any other item costs price x quantity.
//   A package keeps its own rule (packagePrice: the bundle, or per guest).
//   An add-on's price change is multiplied the same way as its item.
//
// Before this rule, every one of those places charged a per-guest item once,
// and the storefront's quantity never reached the admin (see
// docs/BUGS-AUDIT.md item 1).

const PER_GUEST_UNITS = new Set(["per guest", "per person", "per head"]);

// True when the item's billing unit means "for each guest". Case and extra
// spaces do not matter. "per 10 guests" is not per guest: it is sold in
// tens, by quantity.
export function isPerGuestUnit(priceUnit: string | null | undefined): boolean {
  return priceUnit ? PER_GUEST_UNITS.has(priceUnit.trim().toLowerCase().replace(/\s+/g, " ")) : false;
}

// Whether holding the item locks a physical unit. Staff choose it per item
// (Inventory > Items, "Counts against stock"); left unset, a per-guest item
// does not count against stock and everything else does.
export function countsAgainstStock(item: { countsAgainstStock?: boolean | null; priceUnit?: string | null }): boolean {
  return item.countsAgainstStock ?? !isPerGuestUnit(item.priceUnit);
}

export type PriceItem = { id: string; name: string; price: number | null; priceUnit: string | null };
export type PriceAddon = { itemId: string; priceDelta: number };

export type PricedLine = {
  itemId: string;
  name: string;
  perGuest: boolean;
  // Units of the item (1 for a per-guest item).
  quantity: number;
  // The guest count a per-guest line is priced on, else null.
  guests: number | null;
  // What the price is multiplied by: the guest count or the quantity.
  multiplier: number;
  unitPrice: number | null;
  // Dollars for this line, its add-ons included. Null when unpriced.
  lineTotal: number | null;
};

export type Priced = {
  lines: PricedLine[];
  // Dollars, add-ons included. Null when nothing has a price.
  total: number | null;
  addonsTotal: number;
  // True when some line is billed per guest.
  hasPerGuest: boolean;
};

export class PricingError extends Error {
  readonly status = 400;
  readonly reason: string;
  readonly field = "guestCount";
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

const cents = (n: number) => Math.round(n * 100) / 100;

// The cart's total. quantities name units per item (missing means one); a
// package's own quantities come in the same way. guestCount is the order's
// guest count. Throws PricingError guest-count-required when a per-guest
// item is in a cart without a count, and the package's own GuestCountError
// reasons (as PricingError) for a per-guest package.
export function priceCart(input: {
  items: PriceItem[];
  quantities?: Record<string, number>;
  guestCount?: number | null;
  addons?: PriceAddon[];
  pkg?: PackagePricing | null;
}): Priced {
  const guests = input.guestCount ?? null;
  const addons = input.addons ?? [];
  const pkg = input.pkg ?? null;
  const lines: PricedLine[] = input.items.map((item) => {
    // Inside a package the package is the price; its items are not billed
    // per guest on top of it.
    const perGuest = !pkg && isPerGuestUnit(item.priceUnit);
    const quantity = perGuest ? 1 : Math.max(1, Math.floor(input.quantities?.[item.id] ?? 1));
    const multiplier = perGuest ? (guests ?? 0) : quantity;
    const delta = addons.filter((a) => a.itemId === item.id).reduce((s, a) => s + a.priceDelta, 0);
    const lineTotal = pkg ? cents(delta * multiplier) : item.price === null ? null : cents((item.price + delta) * multiplier);
    return { itemId: item.id, name: item.name, perGuest, quantity, guests: perGuest ? guests : null, multiplier, unitPrice: item.price, lineTotal };
  });
  const needing = lines.filter((l) => l.perGuest);
  if (needing.length > 0 && (guests === null || !Number.isInteger(guests) || guests < 1)) {
    const names = needing.map((l) => l.name);
    const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
    throw new PricingError("guest-count-required", `Tell us how many guests, so we can price ${list}. ${names.length === 1 ? "It is" : "They are"} priced per guest.`);
  }
  const addonsTotal = cents(lines.reduce((s, l) => s + addons.filter((a) => a.itemId === l.itemId).reduce((t, a) => t + a.priceDelta, 0) * l.multiplier, 0));
  if (pkg) {
    let base: number;
    try {
      base = packagePrice(pkg, guests);
    } catch (err) {
      if (err instanceof GuestCountError) throw new PricingError(err.reason, err.message);
      throw err;
    }
    return { lines, total: cents(base + addonsTotal), addonsTotal, hasPerGuest: false };
  }
  const priced = lines.filter((l) => l.lineTotal !== null && l.unitPrice !== null);
  // Nothing priced means nothing to quote, add-ons or not (as before).
  const total = priced.length === 0 ? null : cents(priced.reduce((s, l) => s + (l.lineTotal as number), 0));
  return { lines, total, addonsTotal, hasPerGuest: needing.length > 0 };
}

// What one more of an item adds to a booking already made: price times the
// booking's guest count for a per-guest item (or once, when the booking has
// no count), else the price once. Used by the admin's add and remove item.
export function chargeForOne(item: { price: unknown; priceUnit: string | null }, bookingGuests: number | null): number {
  const price = item.price === null || item.price === undefined ? 0 : Number(item.price);
  return cents(isPerGuestUnit(item.priceUnit) && bookingGuests ? price * bookingGuests : price);
}
