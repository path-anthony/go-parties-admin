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
