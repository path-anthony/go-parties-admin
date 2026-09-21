import { ADDON_GROUPS_INCLUDE, publicAddonGroups } from "./addons.js";

// What any customer-facing endpoint needs to load to build a public item.
// Loading more (notes for the Ask GO prompt, say) is fine; what leaves the
// server is decided by toPublicItem, not by the query.
export const PUBLIC_ITEM_RELATIONS = {
  _count: { select: { units: true } },
  addonGroups: ADDON_GROUPS_INCLUDE.addonGroups,
};

type PublicItemSource = {
  id: string;
  name: string;
  category: string;
  price: unknown;
  priceUnit: string | null;
  photoUrl: string | null;
  _count: { units: number };
  addonGroups: Parameters<typeof publicAddonGroups>[0];
};

// The one allowlist for an item shown to a customer, used by the public
// catalog and by Ask GO. It builds a new object field by field, so a
// column added to Item later (or an internal one that exists now: notes,
// accountId, timestamps) can't reach a customer by being spread through.
export function toPublicItem(item: PublicItemSource) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price === null ? null : Number(item.price),
    priceUnit: item.priceUnit,
    photoUrl: item.photoUrl,
    hasUnits: item._count.units > 0,
    addonGroups: publicAddonGroups(item.addonGroups),
  };
}
