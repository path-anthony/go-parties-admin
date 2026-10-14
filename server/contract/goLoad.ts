import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { getSettings } from "../settings.js";
import { apiBase } from "./links.js";
import { composeGoDocument, goContractMissing, goContractReadinessMessage, goDocumentHash, rollUpServices, type BookedLine, type GoDocument, type GoSignature, type RowOverride } from "./goDocument.js";
import { currentTerms, serviceRows, termsVersionById } from "./goTerms.js";
import type { GoTokenValues } from "./goTemplate.js";

// Gathers everything the GO contract needs for one agreement and composes the
// document (server/contract/goDocument.ts does the composing with no database).

export const DEFAULT_LOGO = readFileSync(new URL("../assets/go-logo.png", import.meta.url));

// The logo as bytes and a content type, uploaded or the built-in placeholder.
export async function contractLogo(accountId: string): Promise<{ bytes: Buffer; type: string; etag: string }> {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { contractLogo: true } });
  const m = a.contractLogo ? /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(a.contractLogo) : null;
  const bytes = m ? Buffer.from(m[2].replace(/\s/g, ""), "base64") : DEFAULT_LOGO;
  const type = m ? m[1].toLowerCase().replace("jpg", "jpeg") : "image/png";
  return { bytes, type, etag: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
}

export function numbersFrom(settings: Awaited<ReturnType<typeof getSettings>>): GoTokenValues {
  return {
    retainerPercent: settings.depositPercentage,
    lateCancellationDays: settings.cancellationWindowDays,
    balanceDueDays: settings.balanceDueDays,
    rescheduleFeePercent: settings.rescheduleFeePercent,
    outsidePlannerChargePercent: settings.outsidePlannerChargePercent,
    returnedCheckFee: settings.returnedCheckFee,
  };
}

const BOOKING_FOR_CONTRACT = {
  units: { include: { unit: { select: { item: { select: { id: true, name: true, category: true, price: true, skills: true } } } } } },
  gigs: { where: { status: { not: "Cancelled" } }, select: { itemId: true, itemName: true } },
} as const;

// The booking's items as contract lines: one per item, with how many units or
// people were booked and the item's price in cents.
export async function bookedLines(bookingId: string): Promise<BookedLine[]> {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: BOOKING_FOR_CONTRACT });
  const lines = new Map<string, BookedLine>();
  for (const row of b.units) {
    const item = row.unit.item;
    const cur = lines.get(item.id) ?? { itemId: item.id, name: item.name, category: item.category, quantity: 0, unitPriceCents: item.price === null ? null : Math.round(Number(item.price) * 100), needsCrew: item.skills.length > 0 };
    cur.quantity += 1;
    lines.set(item.id, cur);
  }
  const crewOnly = new Map<string, number>();
  for (const g of b.gigs) {
    if (!g.itemId || lines.has(g.itemId)) continue;
    crewOnly.set(g.itemId, (crewOnly.get(g.itemId) ?? 0) + 1);
  }
  if (crewOnly.size > 0) {
    const items = await prisma.item.findMany({ where: { id: { in: [...crewOnly.keys()] } }, select: { id: true, name: true, category: true, price: true, skills: true } });
    for (const item of items) {
      const gigs = crewOnly.get(item.id) ?? 1;
      lines.set(item.id, { itemId: item.id, name: item.name, category: item.category, quantity: Math.max(1, Math.round(gigs / Math.max(1, item.skills.length))), unitPriceCents: item.price === null ? null : Math.round(Number(item.price) * 100), needsCrew: true });
    }
  }
  return [...lines.values()];
}

export type GoContext = {
  agreementId: string;
  bookingId: string;
  document: GoDocument;
  contentHash: string;
  missing: string[];
  readiness: string | null;
};

// The GO contract for an agreement as it reads right now. `signatures` lets
// the signing step add the client's lines; otherwise only GO's (applied at
// send) is present.
export async function buildGoDocument(agreementId: string, opts: { client?: GoSignature | null; additional?: GoSignature | null; now?: Date } = {}): Promise<GoContext> {
  const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
  if (!agreement.bookingId) throw new Error("The GO contract is for bookings; a design request has no contract until it becomes one.");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: agreement.bookingId } });
  const [settings, terms, rows, lines, logo] = await Promise.all([
    getSettings(agreement.accountId),
    agreement.termsVersionId ? termsVersionById(agreement.termsVersionId).then((t) => t ?? currentTerms(agreement.accountId)) : currentTerms(agreement.accountId),
    serviceRows(agreement.accountId),
    bookedLines(b.id),
    contractLogo(agreement.accountId),
  ]);
  const overrides = (b.contractServices ?? {}) as Record<string, RowOverride>;
  const rolled = rollUpServices(rows, lines, overrides);
  const sentAt = agreement.goSignedAt ?? agreement.contractSentAt ?? opts.now ?? new Date();
  const document = composeGoDocument({
    terms: terms.content,
    numbers: numbersFrom(settings),
    company: {
      name: settings.contractCompanyName,
      addressLine: settings.contractAddressLine,
      phone: settings.contractPhone,
      email: settings.contractEmail,
      website: settings.contractWebsite,
      footerLine: settings.contractFooterLine,
      logoUrl: `${apiBase()}/api/contracts/logo.png?v=${logo.etag}`,
    },
    sentAt,
    signAndPayWindowDays: settings.signAndPayWindowDays,
    client: {
      nameOrg: b.customerName,
      email: b.email,
      mailingAddress: b.mailingAddress,
      city: b.city,
      state: b.state,
      zip: b.zip,
      phoneHome: b.phoneHome,
      phoneWork: b.phoneWork,
      phoneCell: b.phoneCell ?? b.phone,
    },
    event: {
      type: b.occasion,
      guestOfHonor: b.guestOfHonor,
      date: b.eventDate.toISOString().slice(0, 10),
      timeFrom: b.timeFrom,
      timeTo: b.timeTo,
      expectedGuests: b.expectedGuests,
      ageRange: b.ageRange,
      venueName: b.venueName,
      venueAddress: b.address,
      venuePhone: b.venuePhone,
      onsiteContactName: b.onsiteContactName,
      onsiteContactPhone: b.onsiteContactPhone,
      planner: b.planner,
    },
    specialRequests: b.specialRequests,
    rows: rolled,
    discount: {
      percent: b.discountPercent === null ? null : Number(b.discountPercent),
      amountCents: b.discountAmount === null ? null : Math.round(Number(b.discountAmount) * 100),
      description: b.discountDescription,
    },
    signatures: {
      client: opts.client ?? null,
      additional: opts.additional ?? null,
      go: agreement.goSignerName ? { printedName: agreement.goSignerName, signedAt: (agreement.goSignedAt ?? sentAt).toISOString() } : null,
    },
  });
  const missing = goContractMissing({ venueName: b.venueName, onsiteContactName: b.onsiteContactName, onsiteContactPhone: b.onsiteContactPhone, expectedGuests: b.expectedGuests, timeFrom: b.timeFrom, timeTo: b.timeTo });
  return { agreementId, bookingId: b.id, document, contentHash: goDocumentHash(document), missing, readiness: goContractReadinessMessage(missing) };
}

// What the booking is missing before its GO contract can go out, in words.
export async function goReadinessFor(bookingId: string): Promise<string | null> {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { venueName: true, onsiteContactName: true, onsiteContactPhone: true, expectedGuests: true, timeFrom: true, timeTo: true } });
  return goContractReadinessMessage(goContractMissing(b));
}
