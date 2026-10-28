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
  selectMode: string;
  maxSelect: number | null;
  addons: { id: string; name: string; priceDelta: unknown }[];
};

export const SELECT_MODES = ["one", "many"] as const;
export type SelectMode = (typeof SELECT_MODES)[number];
export const selectModeOf = (value: string): SelectMode => (value === "many" ? "many" : "one");

// The public shape: ids, names, whether a choice is forced, how many may be
// picked, and the price delta as a plain number. Nothing internal
// (positions, timestamps).
export function publicAddonGroups(groups: GroupRow[]) {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    required: group.required,
    selectMode: selectModeOf(group.selectMode),
    maxSelect: group.selectMode === "many" ? group.maxSelect : null,
    addons: group.addons.map((addon) => ({ id: addon.id, name: addon.name, priceDelta: Number(addon.priceDelta) })),
  }));
}

// Pure. Whether a count of picks is allowed in a group: one for "one",
// up to maxSelect (or any number) for "many". Returns the refusal, or null.
export function selectionProblem(group: { name: string; selectMode: string; maxSelect: number | null }, count: number, itemName: string): string | null {
  if (count <= 1) return null;
  if (selectModeOf(group.selectMode) === "one") return `Pick one ${group.name} for ${itemName}, not several.`;
  if (group.maxSelect !== null && count > group.maxSelect) return `Pick up to ${group.maxSelect} ${group.name} for ${itemName}.`;
  return null;
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
// takes one choice (or, for a "many" group, up to its limit; Block A3), and
// every required group has to be answered. Every pick is priced, so a
// "many" group adds up its deltas.
// Throws AddonSelectionError with a message a customer can act on.
// enforceRequired is on for customers; the admin turns it off so Andy can
// correct a booking's choices without being forced to answer everything.
export async function resolveAddons(
  items: { id: string; name: string }[],
  selections: Map<string, string[]>,
  { enforceRequired = true }: { enforceRequired?: boolean } = {},
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
    const counts = new Map<string, number>();

    for (const addonId of wanted) {
      const group = itemGroups.find((g) => g.addons.some((addon) => addon.id === addonId));
      if (!group) {
        throw new AddonSelectionError("addon-invalid", `One of the options picked isn't an option for ${item.name}.`);
      }
      const count = (counts.get(group.id) ?? 0) + 1;
      counts.set(group.id, count);
      const problem = selectionProblem(group, count, item.name);
      if (problem) throw new AddonSelectionError("addon-invalid", problem);
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
    if (enforceRequired && missing.length > 0) {
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
