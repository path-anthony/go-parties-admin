// The storefront's sub-occasion strings, grouped the way it groups them.
// Source of truth is go-parties-app/src/data/catalog.ts (SUB_OCC); a
// package's occasion has to match one of these exactly for
// GET /api/packages/public?occasion= to find it.
export const OCCASION_GROUPS: { label: string; occasions: string[] }[] = [
  { label: "Kids party", occasions: ["Birthday", "Bar/Bat Mitzvah", "Sweet 16", "Baby shower", "Graduation"] },
  { label: "Adult party", occasions: ["Birthday", "Bachelor/Bachelorette", "Anniversary", "Retirement", "Housewarming"] },
  {
    label: "Wedding",
    occasions: ["Ceremony + reception", "Reception only", "Engagement party", "Rehearsal dinner", "Bridal shower"],
  },
  { label: "Corporate", occasions: ["Holiday party", "Team building", "Product launch", "Client appreciation", "Grand opening"] },
];

export const ALL_OCCASIONS: string[] = [...new Set(OCCASION_GROUPS.flatMap((group) => group.occasions))];

// The four groups' names (Kids party, Adult party, Wedding, Corporate).
export const OCCASION_GROUP_LABELS: string[] = OCCASION_GROUPS.map((group) => group.label);

// Everything an occasion can be called: a group's name or one of its
// sub-occasions. The review list and a booking's occasion draw from this.
export const KNOWN_OCCASIONS: string[] = [...new Set([...OCCASION_GROUP_LABELS, ...ALL_OCCASIONS])];

// The groups an occasion belongs to. A group's name belongs to itself; a
// sub-occasion belongs to the group(s) that list it (Birthday is in two).
export function groupsOf(occasion: string): string[] {
  const key = occasion.trim().toLowerCase();
  const own = OCCASION_GROUP_LABELS.filter((label) => label.toLowerCase() === key);
  const containing = OCCASION_GROUPS.filter((group) => group.occasions.some((o) => o.toLowerCase() === key)).map((group) => group.label);
  return [...new Set([...own, ...containing])];
}

// The known spelling of an occasion, ignoring case, or null.
export function canonicalOccasion(value: string): string | null {
  const key = value.trim().toLowerCase();
  return KNOWN_OCCASIONS.find((o) => o.toLowerCase() === key) ?? null;
}
