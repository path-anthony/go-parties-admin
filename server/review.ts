import { groupsOf } from "../src/lib/occasions.js";

// Block F2. Which orders go to staff before anything is held. The rule is an
// amount per occasion group: an order is reviewed when its total is at or
// over the amount for its group (Wedding and Corporate at $5,000, the rest
// at $10,000, all set in Settings > Booking rules > Review rules). Under the
// amount, checkout goes on as normal, whatever the occasion.
//
// Which groups an order belongs to: the occasion the customer picked, and
// what the package is sold for. Both count, so a wedding package booked as a
// "Birthday" is still held to the Wedding amount: a customer cannot pick a
// harmless occasion to stay under the line. An order in two groups is held
// to the lower amount.

// "threshold" is what the rule returns today. "occasion" is the old rule
// (any Wedding or Corporate order at any price); it stays in the type because
// requests made before Block F2 still carry it.
export type ReviewReason = "threshold" | "occasion";

export type ReviewRules = { kids: number; adult: number; wedding: number; corporate: number; other: number };

export const REVIEW_GROUPS: { group: string; key: Exclude<keyof ReviewRules, "other"> }[] = [
  { group: "Kids party", key: "kids" },
  { group: "Adult party", key: "adult" },
  { group: "Wedding", key: "wedding" },
  { group: "Corporate", key: "corporate" },
];

// The occasion groups this order belongs to. Birthday sits in two groups.
export function orderGroups(occasion: string | null | undefined, packageOccasions: string[] = []): string[] {
  const own = occasion && occasion.trim() !== "" ? groupsOf(occasion) : [];
  return [...new Set([...own, ...packageOccasions.flatMap((o) => groupsOf(o))])];
}

// The amount this order is held to, and the group it comes from (null for
// the default line). An order in two groups takes the lower amount.
export function reviewLine(input: { occasion?: string | null; packageOccasions?: string[]; rules: ReviewRules }): { group: string | null; amount: number } {
  const groups = orderGroups(input.occasion, input.packageOccasions);
  const lines = REVIEW_GROUPS.filter((g) => groups.includes(g.group)).map((g) => ({ group: g.group, amount: input.rules[g.key] }));
  if (lines.length === 0) return { group: null, amount: input.rules.other };
  const low = lines.reduce((a, l) => (l.amount < a.amount ? l : a));
  // Birthday is in two groups. When both share the amount, name the occasion
  // itself rather than one of the groups.
  const tied = lines.filter((l) => l.amount === low.amount);
  return tied.length > 1 && input.occasion ? { group: input.occasion.trim(), amount: low.amount } : low;
}

const dollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// "Wedding total is $5,000 or more", "Total is $10,000 or more".
export function reviewSentence(line: { group: string | null; amount: number }): string {
  return line.group ? `${line.group} total is ${dollars(line.amount)} or more` : `Total is ${dollars(line.amount)} or more`;
}

// At the amount counts: $5,000 exactly is reviewed. An order with no price
// is never reviewed by this rule.
export function reviewDecision(input: { total: number | null; occasion?: string | null; packageOccasions?: string[]; rules: ReviewRules }): { reasons: ReviewReason[]; sentence: string | null } {
  const line = reviewLine(input);
  if (input.total !== null && input.total >= line.amount) return { reasons: ["threshold"], sentence: reviewSentence(line) };
  return { reasons: [], sentence: null };
}
