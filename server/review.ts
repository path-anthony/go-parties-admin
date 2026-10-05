import { groupsOf } from "../src/lib/occasions.js";

// Which bookings go to staff before anything is held. A submission needs
// review when its total is over the threshold, or when its occasion is on
// the review list. The list holds group names (Wedding) and/or single
// sub-occasions; a booking's occasion matches if it is listed itself or
// belongs to a listed group, so "Reception only" trips a listed "Wedding".
export type ReviewReason = "threshold" | "occasion";

export function occasionNeedsReview(occasion: string | null | undefined, reviewOccasions: string[]): boolean {
  if (!occasion) return false;
  const listed = new Set(reviewOccasions.map((o) => o.trim().toLowerCase()));
  if (listed.has(occasion.trim().toLowerCase())) return true;
  return groupsOf(occasion).some((group) => listed.has(group.toLowerCase()));
}

// An item category matches a review entry when the category names it, whole
// or as a word ("Wedding Packages" trips a listed "Wedding"). Categories come
// from the cart, so a customer cannot leave them out the way they can leave
// out the optional occasion field.
export function categoryNeedsReview(category: string | null | undefined, reviewOccasions: string[]): boolean {
  if (!category) return false;
  const c = category.trim().toLowerCase();
  return reviewOccasions.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.length >= 3 && (c === e || new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(c));
  });
}

export function reviewReasons(input: {
  total: number | null;
  occasions: string[];
  // Item categories in the cart.
  categories?: string[];
  fullReviewThreshold: number;
  reviewOccasions: string[];
}): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  // "Exceeds": exactly at the threshold does not.
  if (input.total !== null && input.total > input.fullReviewThreshold) reasons.push("threshold");
  if (input.occasions.some((o) => occasionNeedsReview(o, input.reviewOccasions)) || (input.categories ?? []).some((c) => categoryNeedsReview(c, input.reviewOccasions))) reasons.push("occasion");
  return reasons;
}
