// Skills come from the server (the skills table, managed in Settings);
// the fixed sets that stay in code are the gig and offer statuses.
export type Skill = string;

export const GIG_STATUSES = ["Needs Crew", "Offered", "Filled", "Cancelled"] as const;
export type GigStatus = (typeof GIG_STATUSES)[number];

export const OFFER_STATUSES = ["Sent", "Accepted", "Declined"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
