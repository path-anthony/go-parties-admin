import { bookingItemLines } from "./bookingItems.js";
import { buildBookingsList, bookingRow, type BookingFacts } from "./bookingsList.js";
import { daysBefore } from "./contract/goMoney.js";
import { prisma } from "./db.js";
import { bookingMapsUrl } from "./delivery.js";
import { owedStep, usd } from "./payLink.js";
import { amountsFor } from "./payments.js";
import { policyLine, policyStateOf } from "./policyAccept.js";
import { getSettings } from "./settings.js";
import { todayEastern } from "./validate.js";
import { isWeddingBooking } from "./weddingDetails/logic.js";

// Block F3b. Reads the database for the Bookings list and the booking popup.
// The rules are in server/bookingsList.ts (pure). Nothing here writes.

const FACTS_INCLUDE = {
  agreement: { select: { checkboxChecked: true, agreedAt: true, contractStatus: true, contractSentAt: true, contractUrl: true, policyVersion: { select: { version: true } }, contractDocument: { select: { signedAt: true, documentJson: true } } } },
  payments: { orderBy: { createdAt: "asc" as const } },
  package: { select: { name: true, occasions: true } },
  weddingDetails: { select: { status: true } },
  units: { select: { unit: { select: { item: { select: { name: true } } } } } },
  gigs: { select: { itemName: true, skill: true, status: true, filledById: true } },
  cancellationRequests: { where: { status: "Open" }, select: { id: true } },
  lead: { select: { source: true } },
  designRequest: { select: { id: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];
function loadRows(accountId: string, id?: string) {
  return prisma.booking.findMany({ where: { accountId, ...(id ? { id } : {}) }, include: FACTS_INCLUDE, orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }], take: 5000 });
}

type Settings = Awaited<ReturnType<typeof getSettings>>;

function factsOf(b: Row, settings: Settings): BookingFacts & { money: ReturnType<typeof amountsFor>; owed: ReturnType<typeof owedStep> } {
  const money = amountsFor(b, b.payments, settings);
  const owed = owedStep(b, money);
  const eventDate = b.eventDate.toISOString().slice(0, 10);
  const live = b.gigs.filter((g) => g.status !== "Cancelled");
  // What is still owed on the balance, whatever step comes first.
  const balanceOwed = money.balancePaid ? 0 : (money.balanceDueCents ?? 0);
  return {
    id: b.id,
    leadId: b.leadId,
    customerName: b.customerName,
    email: b.email,
    phone: b.phone,
    eventDate,
    eventTime: b.eventTime,
    occasion: b.occasion,
    stage: b.status,
    rush: b.rush,
    totalCents: money.totalCents,
    paidCents: money.paidCents,
    needsSignature: owed.step === "sign" || (b.tier === 2 && b.agreement?.contractStatus !== "Signed"),
    contractSentAt: b.agreement?.contractSentAt?.toISOString() ?? null,
    retainerPaid: money.retainerPaid,
    retainerOwedCents: owed.step === "retainer" || owed.step === "sign" ? owed.amountCents : null,
    balanceOwedCents: balanceOwed > 0 ? balanceOwed : null,
    balanceDueDate: money.totalCents === null ? null : daysBefore(eventDate, settings.balanceDueDays),
    payLinkSentAt: b.payLinkSentAt?.toISOString() ?? null,
    cancellationRequested: b.cancellationRequests.length > 0,
    policy: policyStateOf(b),
    weddingDetailsMissing: isWeddingBooking({ weddingOverride: b.weddingOverride, occasion: b.occasion, package: b.package }) && b.weddingDetails?.status !== "submitted",
    crewNeeded: live.length,
    crewUnassigned: live.filter((g) => g.filledById === null).length,
    items: bookingItemLines(b.units, b.gigs),
    packageName: b.package?.name ?? null,
    money,
    owed,
  };
}

export async function loadBookingsList(accountId: string, now = new Date()) {
  const [rows, settings] = await Promise.all([loadRows(accountId), getSettings(accountId)]);
  const today = todayEastern(now);
  return { today, ...buildBookingsList(rows.map((b) => factsOf(b, settings)), today) };
}

export type HistoryLine = { at: string; text: string; by: string | null };

const KIND_WORD: Record<string, string> = { call: "Call: ", text: "Text: ", email: "Email: " };

// Everything the booking popup shows that the booking row itself does not
// carry: the money, the paperwork in words, and one history, newest first.
export async function loadBookingSummary(accountId: string, id: string, now = new Date()) {
  const [rows, settings] = await Promise.all([loadRows(accountId, id), getSettings(accountId)]);
  const b = rows[0];
  if (!b) return null;
  const today = todayEastern(now);
  const f = factsOf(b, settings);
  const row = bookingRow(f, today);
  const policy = f.policy;
  const more = await prisma.booking.findUniqueOrThrow({ where: { id }, select: { policyAcceptedText: true, lead: { select: { id: true, customerName: true, activities: { orderBy: { createdAt: "desc" }, take: 200 } } } } });
  const history: HistoryLine[] = [];
  history.push({ at: b.createdAt.toISOString(), text: `Booking made${b.origin === "storefront" ? " in the store" : b.origin === "staff" ? " by staff" : ""}.`, by: null });
  for (const a of more.lead?.activities ?? []) history.push({ at: a.createdAt.toISOString(), text: `${a.kind ? (KIND_WORD[a.kind] ?? "") : ""}${a.text}`, by: a.userName });
  for (const p of b.payments) {
    if (p.status !== "succeeded" && p.status !== "refunded" && p.status !== "disputed") continue;
    history.push({ at: (p.paidAt ?? p.createdAt).toISOString(), text: `${p.kind === "retainer" ? "Retainer" : p.kind === "balance" ? "Balance" : "Payment"} of ${usd(p.amountCents)} received${p.method === "card" ? " by card" : `, ${p.method}, recorded by staff`}.`, by: null });
  }
  if (b.agreement?.contractSentAt) history.push({ at: b.agreement.contractSentAt.toISOString(), text: "Contract link sent.", by: null });
  if (b.agreement?.contractDocument?.signedAt && b.agreement.contractStatus === "Signed") history.push({ at: b.agreement.contractDocument.signedAt.toISOString(), text: "Contract signed by the customer.", by: null });
  if (b.payLinkSentAt) history.push({ at: b.payLinkSentAt.toISOString(), text: "Pay link last sent.", by: b.payLinkSentByName });
  if (b.confirmedAt) history.push({ at: b.confirmedAt.toISOString(), text: "Confirmed: the retainer was paid.", by: null });
  history.sort((x, y) => y.at.localeCompare(x.at));
  return {
    today,
    row,
    lead: more.lead ? { id: more.lead.id, name: more.lead.customerName } : null,
    where: { address: b.address, mapsUrl: bookingMapsUrl(b), setupNotes: b.setupNotes, guestCount: b.guestCount },
    money: {
      total: f.money.totalCents === null ? null : f.money.totalCents / 100,
      paid: f.money.paidCents / 100,
      owedNow: f.owed.amountCents === null ? null : f.owed.amountCents / 100,
      owedStep: f.owed.step,
      retainer: f.money.retainerDueCents === null ? null : f.money.retainerDueCents / 100,
      retainerPaid: f.money.retainerPaid,
      balance: f.balanceOwedCents === null ? 0 : f.balanceOwedCents / 100,
      balancePaid: f.money.balancePaid,
      balanceDueDate: f.balanceDueDate,
    },
    paperwork: {
      path: b.tier === 2 ? ("contract" as const) : ("policy" as const),
      policy: { ...policy, line: policyLine(policy), acceptedText: more.policyAcceptedText },
      contract: b.tier === 2 ? { status: b.agreement?.contractStatus === "Signed" ? "Signed" : b.agreement?.contractSentAt ? "Sent, not signed" : "Not sent", sentAt: b.agreement?.contractSentAt?.toISOString() ?? null, signedAt: b.agreement?.contractDocument?.signedAt?.toISOString() ?? null, pdfUrl: b.agreement?.contractUrl ?? null } : null,
      weddingDetailsMissing: f.weddingDetailsMissing,
    },
    history,
  };
}
