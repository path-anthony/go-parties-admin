import { prisma } from "./db.js";
import { currentPolicy, fillPolicyText } from "./policy.js";
import { getSettings } from "./settings.js";

// Block F3b. Who accepted the rental policy on a booking, and how.
//
// A contract booking (tier 2) has no policy to accept: the contract is the
// agreement. Every other booking is on the policy path, and the policy is
// accepted in one of three ways:
//
//   customer, on the pay link   the customer ticked the box on the pay screen;
//                               the time, the version and the exact text they
//                               saw are stored on the booking
//   customer, at checkout       the customer ticked the box in the store when
//                               they held the date (the agreement row)
//   staff, by phone             staff ticked "the customer agreed" when they
//                               made the booking; a record of a conversation,
//                               not the customer's own acceptance
//
// Pure, so the Bookings list, the booking popup, the pay link and the
// customer's bookings all say the same thing.

export type PolicyFacts = {
  tier: number | null;
  origin: string | null;
  policyAcceptedAt: Date | null;
  policyAcceptedVersion: number | null;
  agreement?: { checkboxChecked: boolean; agreedAt: Date; policyVersion?: { version: number } | null } | null;
  lead?: { source: string } | null;
  // A booking made from a storefront request carries the tick the customer
  // gave in the store, even though staff made the booking.
  designRequest?: { id: string } | null;
};

export type PolicyState = {
  // False for a contract booking.
  needed: boolean;
  // Who accepted it: the customer themselves, staff on their behalf, nobody.
  by: "customer" | "staff" | "nobody";
  via: "pay-link" | "checkout" | "phone" | null;
  at: string | null;
  version: number | null;
};

const fromStore = (b: PolicyFacts) => (b.origin ? b.origin === "storefront" : b.lead?.source === "storefront") || Boolean(b.designRequest);

export function policyStateOf(b: PolicyFacts): PolicyState {
  if (b.tier === 2) return { needed: false, by: "nobody", via: null, at: null, version: null };
  if (b.policyAcceptedAt) return { needed: true, by: "customer", via: "pay-link", at: b.policyAcceptedAt.toISOString(), version: b.policyAcceptedVersion };
  const a = b.agreement;
  if (a?.checkboxChecked) {
    const version = a.policyVersion?.version ?? null;
    if (fromStore(b)) return { needed: true, by: "customer", via: "checkout", at: a.agreedAt.toISOString(), version };
    return { needed: true, by: "staff", via: "phone", at: a.agreedAt.toISOString(), version };
  }
  return { needed: true, by: "nobody", via: null, at: null, version: null };
}

// True when the customer themselves accepted it. This is what the pay link
// and the customer's bookings report.
export const policyAcceptedByCustomer = (b: PolicyFacts): boolean => policyStateOf(b).by === "customer";

const longDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });

// The one line staff read on a booking.
export function policyLine(s: PolicyState): string {
  if (!s.needed) return "This booking is on a contract, so there is no separate policy to accept.";
  if (s.by === "customer") return `Policy accepted by customer on ${longDay(s.at as string)}${s.via === "pay-link" ? ", on the pay page" : ", at checkout in the store"}${s.version ? ` (version ${s.version})` : ""}.`;
  if (s.by === "staff") return `Staff confirmed by phone on ${longDay(s.at as string)} that the customer agreed${s.version ? ` (version ${s.version})` : ""}. The customer has not accepted it themselves yet.`;
  return "Policy not accepted yet. The customer accepts it on the pay page before paying.";
}

export const POLICY_FACTS_SELECT = {
  tier: true,
  origin: true,
  policyAcceptedAt: true,
  policyAcceptedVersion: true,
  agreement: { select: { checkboxChecked: true, agreedAt: true, policyVersion: { select: { version: true } } } },
  lead: { select: { source: true } },
  designRequest: { select: { id: true } },
} as const;

export type AcceptResult =
  | { ok: true; created: boolean; acceptedAt: Date; version: number | null }
  | { ok: false; status: number; reason: "not-needed" | "closed" | "policy-changed" | "no-policy"; error: string; policy?: { id: string; version: number; text: string } };

// The customer ticked the policy box on the pay screen. Records the time and
// the exact version and text. The first acceptance stands: a second call
// changes nothing and answers with the first. When the screen names the
// version it showed and that is no longer the current one, nothing is
// recorded and the current text comes back so the customer can read it.
export async function acceptPolicy(bookingId: string, shown: { policyId: string | null }, now = new Date()): Promise<AcceptResult> {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { id: true, accountId: true, status: true, leadId: true, ...POLICY_FACTS_SELECT } });
  if (b.tier === 2) return { ok: false, status: 409, reason: "not-needed", error: "This booking is on a contract. There is no separate policy to accept." };
  if (b.policyAcceptedAt) return { ok: true, created: false, acceptedAt: b.policyAcceptedAt, version: b.policyAcceptedVersion };
  if (b.status === "Cancelled" || b.status === "Released" || b.status === "Completed") return { ok: false, status: 409, reason: "closed", error: "This booking is cancelled or finished." };
  const [policy, settings] = await Promise.all([currentPolicy(b.accountId), getSettings(b.accountId)]);
  if (policy.text.trim() === "") return { ok: false, status: 409, reason: "no-policy", error: "There is no policy to accept right now." };
  const text = fillPolicyText(policy.text, settings);
  if (shown.policyId !== null && shown.policyId !== policy.id) {
    return { ok: false, status: 409, reason: "policy-changed", error: "The policy was updated. Please read it again.", policy: { id: policy.id, version: policy.version, text } };
  }
  // One conditional update, so two taps record one acceptance.
  const won = await prisma.booking.updateMany({ where: { id: b.id, policyAcceptedAt: null }, data: { policyAcceptedAt: now, policyAcceptedVersionId: policy.id, policyAcceptedVersion: policy.version, policyAcceptedText: text } });
  if (won.count === 0) {
    const again = await prisma.booking.findUniqueOrThrow({ where: { id: b.id }, select: { policyAcceptedAt: true, policyAcceptedVersion: true } });
    return { ok: true, created: false, acceptedAt: again.policyAcceptedAt as Date, version: again.policyAcceptedVersion };
  }
  if (b.leadId) await prisma.leadActivity.create({ data: { leadId: b.leadId, kind: "status", text: `The customer accepted the rental policy (version ${policy.version}) on the pay page.` } });
  return { ok: true, created: true, acceptedAt: now, version: policy.version };
}
