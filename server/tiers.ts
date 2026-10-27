import { reviewReasons, type ReviewReason } from "./review.js";

// Block T1. Which agreement a cart needs. Pure; the route gathers the
// numbers. Review rules come first (tier 3, staff look before anything is
// held), then the contract rules (tier 2, the GO contract signed at
// checkout), else the rental policy checkbox (tier 1).

export type Tier = 1 | 2 | 3;

export type TierRules = {
  fullReviewThreshold: number;
  reviewOccasions: string[];
  contractRequiredOver: number;
  contractRequiredForCrewed: boolean;
};

export type TierInput = {
  total: number | null;
  occasions: string[];
  categories: string[];
  // Any item in the cart needs crew.
  crewed: boolean;
};

export type TierReason = ReviewReason | "over-contract-threshold" | "crewed";

export function decideTier(input: TierInput, rules: TierRules): { tier: Tier; reasons: TierReason[] } {
  const review = reviewReasons({
    total: input.total,
    occasions: input.occasions,
    categories: input.categories,
    fullReviewThreshold: rules.fullReviewThreshold,
    reviewOccasions: rules.reviewOccasions,
  });
  if (review.length > 0) return { tier: 3, reasons: review };
  const reasons: TierReason[] = [];
  // "Over": exactly the threshold does not need a contract.
  if (input.total !== null && input.total > rules.contractRequiredOver) reasons.push("over-contract-threshold");
  if (rules.contractRequiredForCrewed && input.crewed) reasons.push("crewed");
  if (reasons.length > 0) return { tier: 2, reasons };
  return { tier: 1, reasons: [] };
}

// Dollars, rounded to cents, of what a tier 1 checkout collects.
export function tier1Amount(total: number, retainerPercent: number, collect: "retainer" | "full"): number {
  if (collect === "full") return Math.round(total * 100) / 100;
  return Math.round(total * retainerPercent) / 100;
}

export const TIER1_COLLECT = ["retainer", "full"] as const;
