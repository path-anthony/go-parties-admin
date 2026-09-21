import { prisma } from "./db.js";

// Groups and their options, always in the order they were arranged.
export const ADDON_GROUPS_INCLUDE = {
  addonGroups: {
    orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }],
    include: { addons: { orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }] } },
  },
};

type GroupRow = {
  id: string;
  name: string;
  required: boolean;
  addons: { id: string; name: string; priceDelta: unknown }[];
};

// The public shape: ids, names, whether a choice is forced, and the price
// delta as a plain number. Nothing internal (positions, timestamps).
export function publicAddonGroups(groups: GroupRow[]) {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    required: group.required,
    addons: group.addons.map((addon) => ({ id: addon.id, name: addon.name, priceDelta: Number(addon.priceDelta) })),
  }));
}

export type ChosenAddon = {
  itemId: string;
  itemName: string;
  addonId: string;
  groupName: string;
  addonName: string;
  priceDelta: number;
};

export class AddonSelectionError extends Error {
  readonly reason: "addon-invalid" | "addon-required";

  constructor(reason: "addon-invalid" | "addon-required", message: string) {
    super(message);
    this.reason = reason;
  }
}

// Reads the request's addon selections: { [itemId]: [addonId, ...] }.
// Returns a message when the shape itself is wrong.
export function parseAddonSelections(value: unknown, itemIds: string[]): Map<string, string[]> | string {
  const selections = new Map<string, string[]>();
  if (value === undefined || value === null) return selections;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "addons must be an object of item id to a list of addon ids";
  }
  for (const [itemId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!itemIds.includes(itemId)) return "addons names an item that isn't in this booking";
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && id !== "")) {
      return "addons must list addon ids for each item";
    }
    const unique = [...new Set(ids)];
    if (unique.length > 0) selections.set(itemId, unique);
  }
  return selections;
}

// Checks the selections against the live configuration of every item being
// booked: each addon has to belong to the item it was sent under, a group
// takes at most one choice, and every required group has to be answered.
// Throws AddonSelectionError with a message a customer can act on.
export async function resolveAddons(
  items: { id: string; name: string }[],
  selections: Map<string, string[]>,
): Promise<ChosenAddon[]> {
  const groups = await prisma.addonGroup.findMany({
    where: { itemId: { in: items.map((item) => item.id) } },
    include: { addons: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  const chosen: ChosenAddon[] = [];
  for (const item of items) {
    const itemGroups = groups.filter((group) => group.itemId === item.id);
    const wanted = selections.get(item.id) ?? [];
    const answered = new Set<string>();

    for (const addonId of wanted) {
      const group = itemGroups.find((g) => g.addons.some((addon) => addon.id === addonId));
      if (!group) {
        throw new AddonSelectionError("addon-invalid", `One of the options picked isn't an option for ${item.name}.`);
      }
      if (answered.has(group.id)) {
        throw new AddonSelectionError("addon-invalid", `Pick one ${group.name} for ${item.name}, not several.`);
      }
      answered.add(group.id);
      const addon = group.addons.find((a) => a.id === addonId)!;
      chosen.push({
        itemId: item.id,
        itemName: item.name,
        addonId: addon.id,
        groupName: group.name,
        addonName: addon.name,
        priceDelta: Number(addon.priceDelta),
      });
    }

    // A required group with no options can't be answered; it's skipped
    // rather than making the item unbookable.
    const missing = itemGroups.filter((g) => g.required && g.addons.length > 0 && !answered.has(g.id));
    if (missing.length > 0) {
      throw new AddonSelectionError(
        "addon-required",
        `${item.name} needs a choice for ${missing.map((g) => g.name).join(", ")}.`,
      );
    }
  }
  return chosen;
}

// "Flavor: Peach (+$10)", "Size: Small (-$25)", "Flavor: Cherry".
export function describeAddon(addon: { groupName: string; addonName: string; priceDelta: unknown }): string {
  const delta = Number(addon.priceDelta);
  const cents = Number.isInteger(delta) ? 0 : 2;
  const money = `$${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: cents, maximumFractionDigits: cents })}`;
  const suffix = delta > 0 ? ` (+${money})` : delta < 0 ? ` (-${money})` : "";
  return `${addon.groupName}: ${addon.addonName}${suffix}`;
}
