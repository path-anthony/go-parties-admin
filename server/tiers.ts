import { reviewDecision, type ReviewReason, type ReviewRules } from "./review.js";

// Block T1, changed in Block F2. Which path an order takes. Pure; the route
// gathers the numbers. The review rule comes first (tier 3: the total is at
// or over the amount for the order's occasion group, so staff look before
// anything is held). Under that amount the contract rule decides: over the
// contract amount, or any crewed item, is tier 2 (the GO contract signed at
// checkout); everything else is tier 1 (the rental policy checkbox).

export type Tier = 1 | 2 | 3;

export type TierRules = {
  review: ReviewRules;
  contractRequiredOver: number;
  contractRequiredForCrewed: boolean;
};

export type TierInput = {
  total: number | null;
  // The occasion the customer picked, and what the package is sold for.
  occasion?: string | null;
  packageOccasions?: string[];
  // Any item in the cart needs crew.
  crewed: boolean;
};

export type TierReason = ReviewReason | "over-contract-threshold" | "crewed";

// The policy or contract path, by price and crew alone. Used on its own when
// staff turn a reviewed request into a booking.
export function baseTier(input: Pick<TierInput, "total" | "crewed">, rules: Pick<TierRules, "contractRequiredOver" | "contractRequiredForCrewed">): { tier: 1 | 2; reasons: TierReason[] } {
  const reasons: TierReason[] = [];
  // "Over": exactly the contract amount does not need a contract.
  if (input.total !== null && input.total > rules.contractRequiredOver) reasons.push("over-contract-threshold");
  if (rules.contractRequiredForCrewed && input.crewed) reasons.push("crewed");
  return reasons.length > 0 ? { tier: 2, reasons } : { tier: 1, reasons: [] };
}

export function decideTier(input: TierInput, rules: TierRules): { tier: Tier; reasons: TierReason[]; reviewReason: string | null } {
  const review = reviewDecision({ total: input.total, occasion: input.occasion, packageOccasions: input.packageOccasions, rules: rules.review });
  if (review.reasons.length > 0) return { tier: 3, reasons: review.reasons, reviewReason: review.sentence };
  return { ...baseTier(input, rules), reviewReason: null };
}

// Dollars, rounded to cents, of what a tier 1 checkout collects.
export function tier1Amount(total: number, retainerPercent: number, collect: "retainer" | "full"): number {
  if (collect === "full") return Math.round(total * 100) / 100;
  return Math.round(total * retainerPercent) / 100;
}

export const TIER1_COLLECT = ["retainer", "full"] as const;
