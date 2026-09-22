// The fixed set of crew skills. Plain strings validated at the API, the
// same way statuses and lead sources are handled everywhere else here, so
// adding one is a one-line change and no migration. The storefront-facing
// copy lives in src/lib/skills.ts; keep the two in step.
export const SKILLS = [
  "DJ/MC",
  "Photographer",
  "Videographer",
  "Photo Booth Attendant",
  "Day-of Coordinator",
  "Waitstaff",
  "Bartender",
] as const;

export type Skill = (typeof SKILLS)[number];

export function isSkill(value: unknown): value is Skill {
  return typeof value === "string" && (SKILLS as readonly string[]).includes(value);
}

export const GIG_STATUSES = ["Needs Crew", "Offered", "Filled", "Cancelled"] as const;
export const OFFER_STATUSES = ["Sent", "Accepted", "Declined"] as const;
