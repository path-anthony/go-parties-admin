import { amountsFor, type Money } from "./payments.js";
import { stripeConfigured } from "./stripe/client.js";
import { daysBefore } from "./contract/goMoney.js";
import { displayStatus } from "../src/lib/bookingStatus.js";
import { bookingMapsUrl } from "./delivery.js";
import { policyStateOf, type PolicyFacts } from "./policyAccept.js";

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
  confirmedAt: Date | null;
  balancePaid: boolean;
  eventDate: Date;
  // Block F1: a cancellation request still waiting on staff, if any.
  // Block F3b: newest first, whatever became of each, so the store can show
  // the outcome without remembering it on the device. A row with no status
  // is one still waiting.
  cancellationRequests?: { id: string; reason: string | null; createdAt: Date; status?: string; decidedAt?: Date | null }[];
  guestCount?: number | null;
  // Block F3b: what policyStateOf reads.
  origin?: string | null;
  policyAcceptedAt?: Date | null;
  policyAcceptedVersion?: number | null;
  lead?: { source: string } | null;
  designRequest?: { id: string } | null;
  agreement?: {
    id: string;
    checkboxChecked?: boolean;
    agreedAt?: Date;
    policyVersion?: { version: number } | null;
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
  // Block A9: the exact place's point.
  addressLat?: number | null;
  addressLng?: number | null;
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
export function customerStage(b: Pick<PortalBooking, "status" | "tier" | "retainerPaid" | "confirmedAt">): string {
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

const isOpen = (r: { status?: string }) => r.status === undefined || r.status === "Open";
const pending = (b: PortalBooking) => b.cancellationRequests?.find(isOpen) ?? null;

// Block F3b. Whether the customer has accepted the rental policy themselves
// (at checkout or on the pay page). A contract booking has none to accept.
export function customerPolicy(b: PortalBooking) {
  const a = b.agreement;
  const facts: PolicyFacts = {
    tier: b.tier,
    origin: b.origin ?? null,
    policyAcceptedAt: b.policyAcceptedAt ?? null,
    policyAcceptedVersion: b.policyAcceptedVersion ?? null,
    agreement: a && a.checkboxChecked !== undefined && a.agreedAt ? { checkboxChecked: a.checkboxChecked, agreedAt: a.agreedAt, policyVersion: a.policyVersion ?? null } : null,
    lead: b.lead ?? null,
    designRequest: b.designRequest ?? null,
  };
  const s = policyStateOf(facts);
  return { policyRequired: s.needed, policyAccepted: s.by === "customer", policyAcceptedAt: s.by === "customer" ? s.at : null };
}

// Block F3b. The newest request to cancel and what became of it: waiting,
// approved or declined, with the dates. Null when the customer never asked.
// Staff notes on the decision never leave the server.
export function customerCancellation(b: PortalBooking): { id: string; status: "waiting" | "approved" | "declined"; requestedAt: string; decidedAt: string | null; reason: string | null } | null {
  const r = b.cancellationRequests?.[0];
  if (!r) return null;
  const status = r.status === "Approved" ? "approved" : r.status === "Declined" ? "declined" : "waiting";
  return { id: r.id, status, requestedAt: r.createdAt.toISOString(), decidedAt: status === "waiting" ? null : (r.decidedAt?.toISOString() ?? null), reason: r.reason };
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
    // Block F1: set while a cancellation request waits on staff. The booking
    // itself is unchanged until they decide.
    pendingRequest: pending(b) ? { type: "cancellation" as const, id: pending(b)!.id, status: "open" as const, requestedAt: pending(b)!.createdAt.toISOString(), reason: pending(b)!.reason } : null,
    // Block F3b.
    guestCount: b.guestCount ?? null,
    ...customerPolicy(b),
    cancellation: customerCancellation(b),
    delivery: customerDelivery(b),
    // Block A9: a Google Maps link to the exact event address, when known.
    mapsUrl: bookingMapsUrl(b),
  };
}

export const SELF_SERVE_REFUSAL = "Call or text GO to change this booking.";
export const selfServeAllowed = (b: { tier: number | null }) => b.tier !== 2 && b.tier !== 3;
