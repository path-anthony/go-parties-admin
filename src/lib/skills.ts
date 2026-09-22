// Mirror of server/skills.ts. Keep the two in step.
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

export const GIG_STATUSES = ["Needs Crew", "Offered", "Filled", "Cancelled"] as const;
export type GigStatus = (typeof GIG_STATUSES)[number];

export const OFFER_STATUSES = ["Sent", "Accepted", "Declined"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
