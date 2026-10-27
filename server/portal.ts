import { amountsFor, type Money } from "./payments.js";
import { stripeConfigured } from "./stripe/client.js";
import { daysBefore } from "./contract/goMoney.js";
import { displayStatus } from "../src/lib/bookingStatus.js";

// Block T1. The customer portal's view of a booking: the stage in the
// customer's words, the steps left to do, the contract and the money. Pure
// so the storefront's shapes can be proven in tests; the customer route
// loads the rows and calls these.

export type StepKey = "sign" | "retainer" | "balance" | "proposal" | "confirm-date";
export type StepState = "done" | "next" | "waiting" | "blocked";
export type Step = { key: StepKey; state: StepState; at?: string | null };

export type PortalBooking = {
  status: string;
  tier: number | null;
  total: unknown;
  retainerPaid: boolean;
  balancePaid: boolean;
  eventDate: Date;
  agreement?: {
    id: string;
    format: string | null;
    signingToken: string | null;
    contractStatus: string | null;
    contractSentAt: Date | null;
    contractUrl: string | null;
    contractDocument?: { signedAt: Date; documentJson: unknown } | null;
  } | null;
  payments: { kind: string; status: string; amountCents: number; refundedCents: number; paidAt: Date | null }[];
  placeId: string | null;
  address: string | null;
  setupLat: number | null;
  setupLng: number | null;
  setupNotes: string | null;
  addressCheck: string | null;
};

export type PortalSettings = { depositPercentage: number; tier1Collect: string; balanceDueDays: number };

const inactive = (s: string) => s === "Cancelled" || s === "Released" || s === "Completed";

// Held, Requested, Contract Sent, Signed, Retainer Paid, Confirmed,
// Completed, Cancelled, Released. A tier 2 booking reads Requested until its
// retainer is paid: the contract was signed at checkout, the date is held,
// and the retainer confirms it.
export function customerStage(b: Pick<PortalBooking, "status" | "tier" | "retainerPaid">): string {
  const shown = displayStatus(b);
  if (b.tier === 2 && !b.retainerPaid && (shown === "Held" || shown === "Contract Sent" || shown === "Signed")) return "Requested";
  return shown;
}

export function customerSteps(b: PortalBooking, money: Money): Step[] {
  if (inactive(b.status)) return [];
  const signed = b.agreement?.contractStatus === "Signed";
  const signedAt = b.agreement?.contractDocument?.signedAt?.toISOString() ?? null;
  const retainerAt = b.payments.find((p) => p.kind === "retainer" && p.status !== "pending" && p.status !== "failed" && p.status !== "expired")?.paidAt?.toISOString() ?? null;
  const needsRetainer = money.retainerDueCents !== null && money.retainerDueCents > 0;
  const steps: Step[] = [];
  if (b.tier === 2 || b.tier === 3) steps.push({ key: "sign", state: signed ? "done" : "next", at: signedAt });
  if (needsRetainer) {
    const state: StepState = money.retainerPaid ? "done" : b.tier === 2 && !signed ? "blocked" : "next";
    steps.push({ key: "retainer", state, at: money.retainerPaid ? retainerAt : null });
  }
  if (money.balanceDueCents !== null && (money.balanceDueCents > 0 || money.balancePaid)) {
    const state: StepState = money.balancePaid ? "done" : money.retainerPaid ? "next" : "waiting";
    steps.push({ key: "balance", state });
  }
  return steps;
}

export function customerContract(b: PortalBooking): { agreementId: string; status: "none" | "ready" | "sent" | "signed"; signedAt: string | null; pdfUrl: string | null } | null {
  const a = b.agreement;
  if (!a) return null;
  if (a.contractStatus === "Signed") return { agreementId: a.id, status: "signed", signedAt: a.contractDocument?.signedAt?.toISOString() ?? null, pdfUrl: a.contractUrl };
  if (a.format !== "go-v2" && !a.signingToken) return null;
  if (a.contractSentAt) return { agreementId: a.id, status: "sent", signedAt: null, pdfUrl: null };
  if (a.signingToken || a.format === "go-v2") return { agreementId: a.id, status: "ready", signedAt: null, pdfUrl: null };
  return null;
}

export function customerMoney(b: PortalBooking, money: Money, settings: PortalSettings) {
  const live = !inactive(b.status);
  const online = stripeConfigured();
  const signed = b.agreement?.contractStatus === "Signed";
  const retainerAt = b.payments.find((p) => p.kind === "retainer" && (p.status === "succeeded" || p.status === "refunded" || p.status === "disputed"))?.paidAt?.toISOString() ?? null;
  const retainer =
    money.retainerDueCents === null
      ? null
      : { amount: money.retainerDueCents / 100, paid: money.retainerPaid, paidAt: money.retainerPaid ? retainerAt : null, payable: live && online && !money.retainerPaid && (b.tier !== 2 || signed) };
  const balance =
    money.totalCents === null
      ? null
      : {
          amount: money.balanceDueCents === null ? null : money.balanceDueCents / 100,
          dueDate: daysBefore(b.eventDate.toISOString().slice(0, 10), settings.balanceDueDays),
          paid: money.balancePaid,
          payable: live && online && money.retainerPaid && !money.balancePaid && (money.balanceDueCents ?? 0) > 0,
        };
  return { retainer, balance };
}

export function customerDelivery(b: PortalBooking): { formattedAddress: string; setupLat: number | null; setupLng: number | null; setupNotes: string | null; verified: boolean } | null {
  if (!b.placeId || !b.address) return null;
  return { formattedAddress: b.address, setupLat: b.setupLat, setupLng: b.setupLng, setupNotes: b.setupNotes, verified: b.addressCheck === "verified" };
}

// Everything Block T1 adds to the customer booking response.
export function portalFields(b: PortalBooking, settings: PortalSettings) {
  const money = amountsFor(b, b.payments, settings);
  const { retainer, balance } = customerMoney(b, money, settings);
  return {
    tier: b.tier,
    stage: customerStage(b),
    steps: customerSteps(b, money),
    contract: customerContract(b),
    retainer,
    balance,
    rescheduleMode: b.tier === 2 || b.tier === 3 ? ("request" as const) : ("self" as const),
    pendingRequest: null,
    delivery: customerDelivery(b),
  };
}

export const SELF_SERVE_REFUSAL = "Call or text GO to change this booking.";
export const selfServeAllowed = (b: { tier: number | null }) => b.tier !== 2 && b.tier !== 3;
