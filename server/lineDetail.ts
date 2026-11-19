import { isPerGuestUnit } from "./pricing.js";

// Block FIX1b. A booking's (or a request's) lines as a customer reads them:
// what each item is, how it is priced, how many, the price, and the line
// total. Pure; the routes load the rows. This only describes what was
// charged: the totals, retainers and Stripe amounts are still worked out by
// the pricing rule (server/pricing.ts) and amountsFor, never from here.
//
//   quantity  the number the unit price is multiplied by: the guest count on
//             a per-guest line (never 1 for 100 guests), else the units
//   guests    the guest count on a per-guest line, else null
//   kind      how the item is priced, in words: "per guest", "per 10
//             guests", "each", "per day", "per event", or the item's own
//             unit; "in package" for an item inside a package
//   lineTotal unit price x quantity, plus the line's chosen options; null
//             when the item has no price or is part of a package

export type LineDetail = {
  itemId: string | null;
  name: string;
  kind: string;
  perGuest: boolean;
  quantity: number;
  guests: number | null;
  unitPrice: number | null;
  optionsTotal: number;
  lineTotal: number | null;
};

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// How an item is priced, in words. A blank unit reads as "each".
export function pricingKind(priceUnit: string | null | undefined): string {
  if (isPerGuestUnit(priceUnit)) return "per guest";
  const u = (priceUnit ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return u === "" ? "each" : u;
}

type Option = { itemId: string | null; priceDelta: unknown; quantity: number };
// What the options chosen for one item add, as they were charged (an option's
// quantity is how many times its change was counted).
const optionsFor = (itemId: string | null, options: Option[]) => (itemId ? cents(options.filter((o) => o.itemId === itemId).reduce((s, o) => s + Number(o.priceDelta) * o.quantity, 0)) : 0);

export type BookingLineInput = {
  guestCount: number | null;
  inPackage: boolean;
  // One row per unit held.
  units: { item: { id: string; name: string; price: unknown; priceUnit: string | null } }[];
  // Live gigs of items held only through crew (no unit), with the item.
  crewOnly: { itemId: string; name: string; price: unknown; priceUnit: string | null; gigs: number; skills: number }[];
  // Items that hold no unit (Block FIX1), as they were priced.
  lines: { itemId: string | null; itemName: string; quantity: number; guests: number | null; perGuest: boolean; unitPrice: unknown; lineTotal: unknown; priceUnit?: string | null }[];
  options: Option[];
};

export function bookingLineDetail(b: BookingLineInput): LineDetail[] {
  const out: LineDetail[] = [];
  const byItem = new Map<string, { name: string; price: number | null; priceUnit: string | null; units: number }>();
  for (const u of b.units) {
    const cur = byItem.get(u.item.id) ?? { name: u.item.name, price: num(u.item.price), priceUnit: u.item.priceUnit, units: 0 };
    cur.units += 1;
    byItem.set(u.item.id, cur);
  }
  const make = (itemId: string | null, name: string, price: number | null, priceUnit: string | null, units: number): LineDetail => {
    const perGuest = !b.inPackage && isPerGuestUnit(priceUnit);
    const guests = perGuest ? b.guestCount : null;
    // A per-guest item booked before a guest count was kept was charged once.
    const quantity = perGuest && guests ? guests : units;
    const optionsTotal = optionsFor(itemId, b.options);
    return {
      itemId,
      name,
      kind: b.inPackage ? "in package" : pricingKind(priceUnit),
      perGuest,
      quantity,
      guests,
      unitPrice: b.inPackage ? null : price,
      optionsTotal,
      lineTotal: b.inPackage || price === null ? null : cents(price * quantity + optionsTotal),
    };
  };
  for (const [id, v] of byItem) out.push(make(id, v.name, v.price, v.priceUnit, v.units));
  for (const c of b.crewOnly) {
    if (byItem.has(c.itemId)) continue;
    out.push(make(c.itemId, c.name, num(c.price), c.priceUnit, Math.max(1, Math.round(c.gigs / Math.max(1, c.skills)))));
  }
  for (const l of b.lines) {
    if (l.itemId && byItem.has(l.itemId)) continue;
    const quantity = l.perGuest && l.guests ? l.guests : l.quantity;
    const unitPrice = num(l.unitPrice);
    // The line's stored total already carries its options (the pricing rule
    // multiplies them with the item).
    const lineTotal = num(l.lineTotal);
    out.push({
      itemId: l.itemId,
      name: l.itemName,
      kind: b.inPackage ? "in package" : l.perGuest ? "per guest" : pricingKind(l.priceUnit),
      perGuest: l.perGuest,
      quantity,
      guests: l.perGuest ? l.guests : null,
      unitPrice,
      optionsTotal: unitPrice !== null && lineTotal !== null ? cents(lineTotal - unitPrice * quantity) : optionsFor(l.itemId, b.options),
      lineTotal,
    });
  }
  return out;
}

// A storefront request's cart as lines. New requests (Block FIX1) keep how
// each line was priced; older ones are worked out the same way from the cart.
export type RequestCart = {
  items?: { itemId?: string; name: string; quantity: number; price: number | null; perGuest?: boolean; guests?: number | null; lineTotal?: number | null }[];
  addons?: { itemId: string; priceDelta: number; quantity: number }[];
  package?: { name: string } | null;
};

export function requestLineDetail(cart: RequestCart, guestCount: number | null, priceUnits: Map<string, string | null>): LineDetail[] {
  const inPackage = Boolean(cart.package);
  return (cart.items ?? []).map((i) => {
    const priceUnit = i.itemId ? (priceUnits.get(i.itemId) ?? null) : null;
    const perGuest = !inPackage && (i.perGuest === true || isPerGuestUnit(priceUnit));
    const guests = perGuest ? (i.guests ?? guestCount) : null;
    const quantity = perGuest && guests ? guests : i.quantity;
    const optionsTotal = cents((cart.addons ?? []).filter((a) => a.itemId === i.itemId).reduce((s, a) => s + a.priceDelta * a.quantity, 0));
    const lineTotal = inPackage || i.price === null ? null : (i.lineTotal ?? cents(i.price * quantity + optionsTotal));
    return { itemId: i.itemId ?? null, name: i.name, kind: inPackage ? "in package" : perGuest ? "per guest" : pricingKind(priceUnit), perGuest, quantity, guests, unitPrice: inPackage ? null : i.price, optionsTotal, lineTotal };
  });
}

// ---- loading ------------------------------------------------------------------------

// What bookingLineDetail needs from a booking, in one select.
export const LINE_DETAIL_SELECT = {
  guestCount: true,
  packageId: true,
  units: { select: { unit: { select: { item: { select: { id: true, name: true, price: true, priceUnit: true } } } } } },
  gigs: { where: { status: { not: "Cancelled" } }, select: { itemId: true, itemName: true, item: { select: { price: true, priceUnit: true, skills: true } } } },
  lines: { select: { itemId: true, itemName: true, quantity: true, guests: true, perGuest: true, unitPrice: true, lineTotal: true, item: { select: { priceUnit: true } } }, orderBy: { createdAt: "asc" as const } },
  addons: { select: { itemId: true, priceDelta: true, quantity: true } },
} as const;

type LineRow = {
  guestCount: number | null;
  packageId: string | null;
  units: { unit: { item: { id: string; name: string; price: unknown; priceUnit: string | null } } }[];
  gigs: { itemId: string | null; itemName: string; item: { price: unknown; priceUnit: string | null; skills: string[] } | null }[];
  lines: { itemId: string | null; itemName: string; quantity: number; guests: number | null; perGuest: boolean; unitPrice: unknown; lineTotal: unknown; item: { priceUnit: string | null } | null }[];
  addons: { itemId: string | null; priceDelta: unknown; quantity: number }[];
};

export function lineDetailOf(row: LineRow): LineDetail[] {
  const crew = new Map<string, { itemId: string; name: string; price: unknown; priceUnit: string | null; gigs: number; skills: number }>();
  for (const g of row.gigs) {
    if (!g.itemId) continue;
    const cur = crew.get(g.itemId) ?? { itemId: g.itemId, name: g.itemName, price: g.item?.price ?? null, priceUnit: g.item?.priceUnit ?? null, gigs: 0, skills: g.item?.skills.length ?? 1 };
    cur.gigs += 1;
    crew.set(g.itemId, cur);
  }
  return bookingLineDetail({
    guestCount: row.guestCount,
    inPackage: row.packageId !== null,
    units: row.units.map((u) => ({ item: u.unit.item })),
    crewOnly: [...crew.values()],
    lines: row.lines.map((l) => ({ ...l, priceUnit: l.item?.priceUnit ?? null })),
    options: row.addons,
  });
}
