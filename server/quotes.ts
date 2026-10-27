import { prisma } from "./db.js";
import { getDefaultAccount } from "./account.js";
import { resolveAddons, type ChosenAddon } from "./addons.js";
import { loadGoSigner } from "./contracts.js";
import { composeGoDocument, goDocumentHash, rollUpServices, type BookedLine, type GoDocument, type GoSignature } from "./contract/goDocument.js";
import { contractLogo, numbersFrom } from "./contract/goLoad.js";
import { currentTerms, serviceRows, termsVersionById } from "./contract/goTerms.js";
import { apiBase } from "./contract/links.js";
import { needsCrew } from "./gigs.js";
import { getSettings } from "./settings.js";
import { addDays, atEastern, easternDay } from "./automation/time.js";
import { decideTier, type Tier, type TierReason } from "./tiers.js";

// Block T1. A tier 2 quote: the GO contract composed from a cart before a
// booking exists, so the customer reads and signs it in checkout. The
// document is built the same way the sent contract is (goDocument.ts), with
// the client fields empty, GO's signature in place and the confirm-by date
// pinned to the day the quote was made. The hash the customer signs is the
// hash of exactly that document; the hold rebuilds it and refuses anything
// that no longer matches.

export type QuoteCart = {
  itemIds: string[];
  packageId: string | null;
  addons: Record<string, string[]> | null;
  eventDate: string; // YYYY-MM-DD
  eventTime: string | null;
  occasion: string | null;
};

// The cart in a stable spelling: items and add-on ids sorted, so the same
// cart written in a different order makes the same quote.
export function normalizeCart(cart: QuoteCart): QuoteCart {
  const itemIds = [...new Set(cart.itemIds)].sort();
  const addons = cart.addons
    ? Object.fromEntries(
        Object.entries(cart.addons)
          .filter(([itemId, ids]) => itemIds.includes(itemId) && Array.isArray(ids) && ids.length > 0)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([itemId, ids]) => [itemId, [...new Set(ids)].sort()]),
      )
    : null;
  return { itemIds, packageId: cart.packageId || null, addons: addons && Object.keys(addons).length > 0 ? addons : null, eventDate: cart.eventDate, eventTime: cart.eventTime?.trim() || null, occasion: cart.occasion?.trim() || null };
}

// A quote lives until the end of the day it was made, Eastern.
export function quoteExpiry(now: Date): Date {
  return new Date(atEastern(addDays(easternDay(now), 1), 0, 0).getTime() - 1000);
}

export class CartError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export type ResolvedCart = {
  items: { id: string; name: string; category: string; price: number | null; skills: string[]; unitCount: number }[];
  pkg: { id: string; name: string; price: number; occasions: string[] } | null;
  wanted: { item: ResolvedCart["items"][number]; quantity: number }[];
  addonRows: (ChosenAddon & { quantity: number })[];
  // Dollars, add-ons included. Null when nothing has a price.
  total: number | null;
  crewed: boolean;
  categories: string[];
  occasions: string[];
};

// Prices the cart the way a direct booking does: the package's bundle price
// or each priced item times its quantity, plus the chosen add-ons.
export async function resolveCart(accountId: string, cart: QuoteCart, opts: { enforceRequired?: boolean } = {}): Promise<ResolvedCart> {
  const [pkg, found] = await Promise.all([
    cart.packageId
      ? prisma.package.findFirst({ where: { id: cart.packageId, accountId, status: "Published" }, include: { items: { select: { itemId: true, quantity: true } } } })
      : Promise.resolve(null),
    prisma.item.findMany({ where: { id: { in: cart.itemIds }, accountId }, include: { _count: { select: { units: true } } } }),
  ]);
  if (cart.packageId && !pkg) throw new CartError(404, "not-found", "package not found or not published");
  if (pkg) {
    const packageIds = new Set(pkg.items.map((row) => row.itemId));
    const same = packageIds.size === cart.itemIds.length && cart.itemIds.every((id) => packageIds.has(id));
    if (!same) throw new CartError(400, "package-mismatch", "The items don't match the package. Book the package as it is, or book the items on their own.");
  }
  const items = cart.itemIds.map((id) => found.find((i) => i.id === id)).filter((i) => i !== undefined);
  if (items.length !== cart.itemIds.length) throw new CartError(404, "not-found", cart.itemIds.length === 1 ? "item not found" : "One or more items were not found");
  const mapped = items.map((i) => ({ id: i.id, name: i.name, category: i.category, price: i.price === null ? null : Number(i.price), skills: i.skills, unitCount: i._count.units }));
  const wanted = mapped.map((item) => ({ item, quantity: pkg ? (pkg.items.find((row) => row.itemId === item.id)?.quantity ?? 1) : 1 }));
  const selections = new Map<string, string[]>(Object.entries(cart.addons ?? {}));
  const chosen = await resolveAddons(items, selections, { enforceRequired: opts.enforceRequired ?? false });
  const quantityOf = (itemId: string) => wanted.find((w) => w.item.id === itemId)?.quantity ?? 1;
  const addonRows = chosen.map((a) => ({ ...a, quantity: quantityOf(a.itemId) }));
  const addonsTotal = Math.round(addonRows.reduce((sum, a) => sum + a.priceDelta * a.quantity, 0) * 100) / 100;
  let base: number | null;
  if (pkg) base = Number(pkg.price);
  else {
    const priced = wanted.filter(({ item }) => item.price !== null);
    base = priced.length === 0 ? null : Math.round(priced.reduce((sum, { item, quantity }) => sum + (item.price as number) * quantity, 0) * 100) / 100;
  }
  const total = base === null ? null : Math.round((base + addonsTotal) * 100) / 100;
  return {
    items: mapped,
    pkg: pkg ? { id: pkg.id, name: pkg.name, price: Number(pkg.price), occasions: pkg.occasions } : null,
    wanted,
    addonRows,
    total,
    crewed: mapped.some((i) => needsCrew(i)),
    categories: mapped.map((i) => i.category),
    occasions: [...(cart.occasion ? [cart.occasion] : []), ...(pkg?.occasions ?? [])],
  };
}

export async function tierFor(accountId: string, resolved: ResolvedCart): Promise<{ tier: Tier; reasons: TierReason[] }> {
  const s = await getSettings(accountId);
  return decideTier(
    { total: resolved.total, occasions: resolved.occasions, categories: resolved.categories, crewed: resolved.crewed },
    { fullReviewThreshold: s.fullReviewThreshold, reviewOccasions: s.reviewOccasions, contractRequiredOver: s.contractRequiredOver, contractRequiredForCrewed: s.contractRequiredForCrewed },
  );
}

// The cart as contract lines: one per item, in item id order, the price
// per unit carrying that item's add-on deltas so the contract total matches
// what was quoted.
export function cartLines(resolved: ResolvedCart): BookedLine[] {
  return [...resolved.wanted]
    .sort((a, b) => (a.item.id < b.item.id ? -1 : 1))
    .map(({ item, quantity }) => {
      const deltas = resolved.addonRows.filter((a) => a.itemId === item.id).reduce((sum, a) => sum + a.priceDelta, 0);
      // A package is one price for the whole cart: its items print without
      // a fee each and the bundle price goes on the first line.
      const unitPriceCents = resolved.pkg ? null : item.price === null ? null : Math.round((item.price + deltas) * 100);
      return { itemId: item.id, name: item.name, category: item.category, quantity, unitPriceCents, needsCrew: needsCrew(item) };
    });
}

export type QuoteDocumentInput = {
  accountId: string;
  resolved: ResolvedCart;
  cart: QuoteCart;
  // The instant GO's signature carries and the confirm-by window counts from.
  goSignedAt: Date;
  termsVersionId: string | null;
  client?: { nameOrg: string; email: string | null; phoneCell: string | null; mailingAddress: string | null; city: string | null; state: string | null; zip: string | null } | null;
  signatures?: { client: GoSignature | null; additional: GoSignature | null };
};

// Composes the quote document. With no client, the fields print empty (what
// the customer reads and signs); with one, the same document filled in (what
// is stored as signed).
export async function composeQuoteDocument(input: QuoteDocumentInput): Promise<{ document: GoDocument; contentHash: string; termsVersionId: string }> {
  const [settings, terms, rows, logo, signer] = await Promise.all([
    getSettings(input.accountId),
    input.termsVersionId ? termsVersionById(input.termsVersionId).then((t) => t ?? currentTerms(input.accountId)) : currentTerms(input.accountId),
    serviceRows(input.accountId),
    contractLogo(input.accountId),
    loadGoSigner(input.accountId),
  ]);
  const lines = cartLines(input.resolved);
  const overrides: Record<string, { feeCents?: number | null }> = {};
  const rolled = rollUpServices(rows, lines, overrides);
  // A package's bundle price goes on the first row that has an item.
  if (input.resolved.pkg) {
    const first = rolled.find((r) => !r.isGroupHeading && r.items.length > 0);
    if (first) first.feeCents = Math.round(input.resolved.pkg.price * 100) + Math.round(input.resolved.addonRows.reduce((s, a) => s + a.priceDelta * a.quantity, 0) * 100);
  }
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
    sentAt: input.goSignedAt,
    signAndPayWindowDays: settings.signAndPayWindowDays,
    client: {
      nameOrg: input.client?.nameOrg ?? "",
      email: input.client?.email ?? null,
      mailingAddress: input.client?.mailingAddress ?? null,
      city: input.client?.city ?? null,
      state: input.client?.state ?? null,
      zip: input.client?.zip ?? null,
      phoneHome: null,
      phoneWork: null,
      phoneCell: input.client?.phoneCell ?? null,
    },
    event: {
      type: input.cart.occasion,
      guestOfHonor: null,
      date: input.cart.eventDate,
      timeFrom: input.cart.eventTime,
      timeTo: null,
      expectedGuests: null,
      ageRange: null,
      venueName: null,
      venueAddress: null,
      venuePhone: null,
      onsiteContactName: null,
      onsiteContactPhone: null,
      planner: null,
    },
    specialRequests: null,
    rows: rolled,
    discount: { percent: null, amountCents: null, description: null },
    signatures: {
      client: input.signatures?.client ?? null,
      additional: input.signatures?.additional ?? null,
      go: signer ? { printedName: signer.name, signedAt: input.goSignedAt.toISOString() } : null,
    },
  });
  return { document, contentHash: goDocumentHash(document), termsVersionId: terms.id };
}

export type IssuedQuote = {
  quoteId: string;
  contentHash: string;
  termsVersion: number | null;
  document: GoDocument;
  quoteExpiresAt: string;
  totalCents: number;
  retainerCents: number;
  confirmByDate: string;
};

// Makes and stores a quote for a tier 2 cart.
export async function issueQuote(accountId: string, cart: QuoteCart, resolved: ResolvedCart, now = new Date()): Promise<IssuedQuote> {
  // GO's signature and the confirm-by window are pinned to the quote's day
  // (midnight Eastern), so the same cart quoted twice in a day hashes the same.
  const goSignedAt = atEastern(easternDay(now), 0, 0);
  const composed = await composeQuoteDocument({ accountId, resolved, cart, goSignedAt, termsVersionId: null });
  const d = composed.document;
  const terms = await termsVersionById(composed.termsVersionId);
  const totalCents = typeof d.payment.total === "number" ? d.payment.total : 0;
  const retainerCents = typeof d.payment.retainerAmount === "number" ? d.payment.retainerAmount : 0;
  const expiresAt = quoteExpiry(now);
  const row = await prisma.quote.create({
    data: {
      accountId,
      contentHash: composed.contentHash,
      cart: cart as object,
      document: d as object,
      termsVersionId: composed.termsVersionId,
      confirmByDate: d.header.confirmByDate ?? "",
      goSignedAt,
      totalCents,
      retainerCents,
      expiresAt,
    },
  });
  return { quoteId: row.id, contentHash: row.contentHash, termsVersion: terms?.version ?? null, document: d, quoteExpiresAt: expiresAt.toISOString(), totalCents, retainerCents, confirmByDate: row.confirmByDate };
}

export type QuoteCheck =
  | { ok: true; quote: { id: string; contentHash: string; termsVersionId: string | null; goSignedAt: Date; confirmByDate: string; totalCents: number; retainerCents: number } }
  | { ok: false; reason: "quote-expired" | "contract-changed"; message: string };

const CHANGED = "Your cart or the contract changed. Please read it again.";

// At the hold: the quote exists, is unused and unexpired, the signature
// names its hash, and the contract composed from this cart today still
// hashes the same (the cart, the terms and the numbers are unchanged).
export async function checkQuote(accountId: string, quoteId: string, signedHash: string, cart: QuoteCart, resolved: ResolvedCart, now = new Date()): Promise<QuoteCheck> {
  const q = await prisma.quote.findFirst({ where: { id: quoteId, accountId } });
  if (!q) return { ok: false, reason: "quote-expired", message: CHANGED };
  if (q.usedByBookingId || q.expiresAt.getTime() < now.getTime()) return { ok: false, reason: "quote-expired", message: CHANGED };
  if (signedHash !== q.contentHash) return { ok: false, reason: "contract-changed", message: CHANGED };
  const again = await composeQuoteDocument({ accountId, resolved, cart, goSignedAt: q.goSignedAt ?? q.createdAt, termsVersionId: q.termsVersionId });
  if (again.contentHash !== q.contentHash) return { ok: false, reason: "contract-changed", message: CHANGED };
  return { ok: true, quote: { id: q.id, contentHash: q.contentHash, termsVersionId: q.termsVersionId, goSignedAt: q.goSignedAt ?? q.createdAt, confirmByDate: q.confirmByDate, totalCents: q.totalCents, retainerCents: q.retainerCents } };
}

export async function defaultAccountId(): Promise<string> {
  return (await getDefaultAccount()).id;
}
