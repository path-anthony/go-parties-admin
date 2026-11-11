import { AddonSelectionError, describeAddon, resolveAddons, type ChosenAddon } from "./addons.js";
import { leadStatusForStorefrontBooking, lockFreeUnit } from "./availability.js";
import { NoFreeUnits } from "./bookingOps.js";
import { prisma } from "./db.js";
import { NoCrewFree, createGigs, needsCrew } from "./gigs.js";
import { displayStatus, legacyCustomerStatus } from "../src/lib/bookingStatus.js";
import { sendDesignRequestAck } from "./notify.js";
import { sendPayLink, type PayLinkSend } from "./payLink.js";
import { findLeadMatch } from "./inboxLoad.js";
import { actorFields } from "./actor.js";
import { currentPolicy } from "./policy.js";
import { reviewDecision } from "./review.js";
import { getSettings, reviewRulesOf, rushFor } from "./settings.js";
import { getDefaultAccount } from "./account.js";
import { ipHash, safeErr } from "./log.js";
import { stripControl } from "./sanitize.js";
import { loadGoSigner, signContractFromQuote, token } from "./contracts.js";
import { bookingMapsUrl, deliveryColumns, placeColumns, type Delivery } from "./delivery.js";
import { checkBookingAddress, type ExactPlace } from "./addressLookup.js";
import { queueGoogleSync } from "./google/sync.js";
import { clearRequestAlerts, notifyDesignRequest, notifyLinkedBooking, notifyNewLead } from "./notifications.js";
import { notifyContractSigned } from "./notify.js";
import { createPaymentSession, type PaymentOffer } from "./payments.js";
import { customerStage } from "./portal.js";
import { HIDDEN_MESSAGE, checkQuote, resolveCart, type QuoteCart } from "./quotes.js";
import { GuestCountError, isPerGuest, packagePrice } from "./packagePricing.js";
import { baseTier, decideTier, type Tier } from "./tiers.js";

export const MAX_UNITS_PER_BOOKING = 50;

const out = (status: number, body: unknown) => ({ status, body });

// The price a direct booking is quoted at: the package's bundle price, or
// each priced item times its quantity. Null when nothing has a price.
function quotedTotal(
  pkg: { price: unknown; pricingMode: string; basePrice: unknown; minGuests: number | null; maxGuests: number | null } | null,
  wanted: { item: { price: unknown }; quantity: number }[],
  guestCount: number | null,
): number | null {
  // Block A8: a per-guest package is priced on the count (checked by the caller).
  if (pkg) return packagePrice(pkg, guestCount);
  const priced = wanted.filter(({ item }) => item.price !== null);
  if (priced.length === 0) return null;
  return Math.round(priced.reduce((sum, { item, quantity }) => sum + Number(item.price) * quantity, 0) * 100) / 100;
}

// Everything a booking needs, already validated for shape by the caller
// (the public route for a customer, the staff route for the admin).
export type DirectBookingInput = {
  // Who is asking. Staff bookings are logged as manual leads and may carry
  // a price other than the computed one.
  staff: boolean;
  name: string;
  contact: { phone: string | null; email: string | null };
  // The customer account the booking attaches to, if any.
  customer: { id: string; name: string | null } | null;
  // Block A5: the customer said the event address is their home address.
  eventAddressSameAsHome?: boolean;
  // Block A8: the guest count a per-guest package is priced on.
  guestCount?: number | null;
  itemIds: string[];
  // Units wanted per item when not booking a package; missing means one.
  quantities?: Record<string, number>;
  date: Date;
  dateText: string;
  eventTime: string | null;
  address: string | null;
  selections: Parameters<typeof resolveAddons>[1];
  packageId: string | null;
  // Set only by staff: replaces the computed total (null clears it).
  totalOverride?: number | null;
  // What the booking is for: a group (Wedding) or a sub-occasion. Null when
  // nobody said; a package's own occasions are then used for the review rule.
  occasion?: string | null;
  // Manual, Auto-charge or Reminder link. Recorded only.
  balancePaymentPreference?: string;
  // Whether the customer ticked the agreement box. Staff must confirm it;
  // a storefront booking without it is recorded as unchecked unless the
  // account requires it.
  agreed?: boolean;
  // Set when staff are turning a design request into this booking. That
  // skips the review routing (it has been reviewed), and the request is
  // marked Converted in the same transaction that makes the booking.
  designRequestId?: string | null;
  // The public request's origin, for the agreement record. Storefront only.
  request?: { ip: string | null | undefined; userAgent: string | null | undefined };
  // Block T1. The tier the storefront was told (the server recomputes and
  // refuses a mismatch), the signature taken on the tier 2 quote, and the
  // verified delivery location. Storefront only; staff bookings carry none.
  tier?: Tier | null;
  signature?: HoldSignature | null;
  delivery?: Delivery | null;
  // Block A9: the event address as Google found it (an exact street
  // address), already looked up by the route. When set it is the address
  // and the booking is verified from the start. The pin still comes from
  // delivery when the storefront sent one.
  place?: ExactPlace | null;
  // Block F2: the setup pin and notes a reviewed request carried, handed on
  // when staff turn it into a booking (a staff booking has no delivery).
  pin?: { setupLat: number | null; setupLng: number | null; setupNotes: string | null } | null;
  // Block A9: why the address could not be checked (no key, Google down,
  // the daily cap), when it could not be. Stored with "not checked".
  addressCheckReason?: string | null;
  // Block F1. Staff bookings only: send the customer what they owe next (the
  // contract with the retainer amount, or the pay link) as soon as the
  // booking is made. On unless staff untick it.
  sendPayLink?: boolean;
  // Block F3a. Staff built this booking from a lead (Leads, "Build a booking
  // for them"): the booking hangs on that lead instead of making a new one,
  // and the lead moves to Booked.
  leadId?: string | null;
};

export type HoldSignature = { fullName: string; additionalSignerName: string | null; contentHash: string; quoteId: string };

const QUOTE_CHANGED = "Your cart or the contract changed. Please read it again.";
type UsableQuote = Extract<Awaited<ReturnType<typeof checkQuote>>, { ok: true }>["quote"];

// What is kept with a storefront agreement besides the policy version and
// the time: a keyed hash of the address and the user agent. Nothing for
// staff, who confirm on the customer's behalf from their own machine.
export function agreementEvidence(input: Pick<DirectBookingInput, "staff" | "request">): { agreedIpHash: string | null; agreedUserAgent: string | null } {
  if (input.staff || !input.request) return { agreedIpHash: null, agreedUserAgent: null };
  return {
    agreedIpHash: input.request.ip ? ipHash(input.request.ip) : null,
    agreedUserAgent: input.request.userAgent ? stripControl(input.request.userAgent, 300) || null : null,
  };
}

// The design request was already converted, dismissed, or never existed.
class DesignRequestUnavailable extends Error {}

// The one place a booking is made on a customer's behalf or their own:
// one free unit per item wanted is picked and locked (SKIP LOCKED) in the
// same transaction that writes the Booking, its BookingUnits, its add-ons,
// its gigs and the CRM Lead, so either every item is held or nothing is,
// and two requests racing for the last unit or the last person can't both
// win. The storefront's direct booking and the admin's New booking both
// call this.
export async function createDirectBooking(input: DirectBookingInput): Promise<{ status: number; body: unknown }> {
  const { staff, name, contact, customer, itemIds, quantities = {}, date, dateText, eventTime, address, selections, packageId, totalOverride } = input;
  const occasion = input.occasion ?? null;
  const balancePaymentPreference = input.balancePaymentPreference ?? "Manual";
  const designRequestId = input.designRequestId ?? null;
  const account = await getDefaultAccount();
  // Read-only lookups that don't depend on each other run together. None of
  // them takes a lock or feeds the transaction below, so this changes how
  // long the request waits, not what it guarantees. The rush flag and the
  // lead column are worked out here too rather than inside the transaction,
  // so row locks aren't held while they are read.
  const [pkg, found, leadStatus, rush, settings, policy] = await Promise.all([
    packageId
      ? prisma.package.findFirst({
          where: { id: packageId, accountId: account.id, status: "Published" },
          include: { items: { select: { itemId: true, quantity: true } } },
        })
      : Promise.resolve(null),
    prisma.item.findMany({
      where: { id: { in: itemIds }, accountId: account.id },
      include: { _count: { select: { units: true } } },
    }),
    leadStatusForStorefrontBooking(account.id),
    rushFor(account.id, date),
    getSettings(account.id),
    currentPolicy(account.id),
  ]);
  if (packageId && !pkg) {
    return out(404, { error: "package not found or not published" });
  }
  if (pkg) {
    const packageIds = new Set(pkg.items.map((row) => row.itemId));
    const same = packageIds.size === itemIds.length && itemIds.every((id) => packageIds.has(id));
    if (!same) {
      return out(400, { error: "The items don't match the package. Book the package as it is, or book the items on their own." });
    }
  }
  // Block A8: a hidden item is for staff bookings only.
  if (!staff && found.some((item) => item.hidden)) return out(400, { error: HIDDEN_MESSAGE, reason: "hidden" });
  const guestCount = isPerGuest(pkg ?? { pricingMode: "fixed" }) ? (input.guestCount ?? null) : null;
  if (pkg && isPerGuest(pkg)) {
    try {
      packagePrice(pkg, guestCount);
    } catch (err) {
      if (err instanceof GuestCountError) return out(400, { error: err.message, reason: err.reason });
      throw err;
    }
  }
  // Keep the caller's order so the response lines up with the request.
  const items = itemIds.map((id) => found.find((item) => item.id === id)).filter((item) => item !== undefined);
  if (items.length !== itemIds.length) {
    return out(404, { error: itemIds.length === 1 ? "item not found" : "One or more items were not found" });
  }
  // How many units of each item to hold: the package's quantities, or one.
  const wanted = items.map((item) => ({
    item,
    quantity: pkg ? (pkg.items.find((row) => row.itemId === item.id)?.quantity ?? 1) : (quantities[item.id] ?? 1),
  }));
  if (wanted.reduce((sum, w) => sum + w.quantity, 0) > MAX_UNITS_PER_BOOKING) {
    return out(400, { error: `A booking can hold at most ${MAX_UNITS_PER_BOOKING} units` });
  }
  let chosen: ChosenAddon[];
  try {
    chosen = await resolveAddons(items, selections);
  } catch (err) {
    if (err instanceof AddonSelectionError) {
      return out(400, { error: err.message, reason: err.reason });
    }
    throw err;
  }
  const quantityOf = (itemId: string) => wanted.find((w) => w.item.id === itemId)?.quantity ?? 1;
  const addonRows = chosen.map((addon) => ({ ...addon, quantity: quantityOf(addon.itemId) }));
  const addonsTotal = Math.round(addonRows.reduce((sum, a) => sum + a.priceDelta * a.quantity, 0) * 100) / 100;
  // Nothing priced means nothing to quote, add-ons or not.
  const baseTotal = quotedTotal(pkg, wanted, guestCount);
  const computedTotal = baseTotal === null ? null : Math.round((baseTotal + addonsTotal) * 100) / 100;
  // Staff can confirm a different price on the phone; nobody else can.
  const total = totalOverride === undefined ? computedTotal : totalOverride;

  // Agreement. Staff confirm it on the customer's behalf. A storefront
  // submission carries the ticked box; when the account requires it, one
  // without it is refused, whether it would become a booking or a design
  // request.
  const checkboxChecked = input.agreed === true;
  if (!staff && !checkboxChecked && settings.requireAgreementCheckbox) {
    return out(400, { error: "Please agree to the cancellation and retainer policy to continue.", reason: "agreement-required" });
  }
  const evidence = agreementEvidence(input);

  // Review routing (Block F2). An order whose total is at or over the amount
  // for its occasion group is not held: it becomes a request for staff, and
  // nothing is locked. A request being converted by staff has already been
  // reviewed, so it skips this.
  if (!designRequestId) {
    const review = reviewDecision({ total, occasion, packageOccasions: pkg?.occasions ?? [], rules: reviewRulesOf(settings) });
    const reasons = review.reasons;
    if (reasons.length > 0) {
      // Nothing the customer gave is dropped while the order waits: the exact
      // place, its point, the setup pin and notes, the "same as home" tick
      // and the guest count are kept on the request.
      const sent = input.delivery ?? null;
      const where = input.place
        ? { placeId: input.place.placeId, deliveryComponents: input.place.components, addressLat: input.place.lat, addressLng: input.place.lng }
        : sent
          ? { placeId: sent.placeId, deliveryComponents: sent.components, addressLat: sent.addressLat, addressLng: sent.addressLng }
          : {};
      const request = await prisma.$transaction(async (tx) => {
        const created = await tx.designRequest.create({
        data: {
          accountId: account.id,
          reasons,
          occasion,
          eventDate: date,
          eventTime,
          address,
          customerName: name,
          phone: contact.phone,
          email: contact.email,
          customerId: customer?.id ?? null,
          packageId: pkg?.id ?? null,
          total,
          balancePaymentPreference,
          reviewReason: review.sentence,
          ...where,
          setupLat: sent?.setupLat ?? null,
          setupLng: sent?.setupLng ?? null,
          setupNotes: sent?.setupNotes || null,
          eventAddressSameAsHome: input.eventAddressSameAsHome === true,
          guestCount: input.guestCount ?? null,
          cart: {
            items: wanted.map(({ item, quantity }) => ({
              itemId: item.id,
              name: item.name,
              quantity,
              price: item.price === null ? null : Number(item.price),
            })),
            addons: addonRows.map((a) => ({
              itemId: a.itemId,
              addonId: a.addonId,
              itemName: a.itemName,
              groupName: a.groupName,
              addonName: a.addonName,
              priceDelta: a.priceDelta,
              quantity: a.quantity,
            })),
            package: pkg ? { id: pkg.id, name: pkg.name, price: Number(pkg.price) } : null,
            computedTotal,
          },
        },
        });
        // A storefront customer ticked (or did not tick) the policy box on
        // their way here. That is recorded against the request, with the
        // policy version they saw, exactly as it is for a booking. Requests
        // staff enter carry none: the booking made from it records theirs.
        if (!staff) {
          await tx.agreement.create({
            data: { accountId: account.id, customerId: customer?.id ?? null, designRequestId: created.id, policyVersionId: policy.id, checkboxChecked, ...evidence },
          });
        }
        return created;
      });
      // Tell the customer a person will be in touch. Storefront requests only:
      // when staff enter one they are already talking to the customer.
      if (!staff) void sendDesignRequestAck(request.id);
      await notifyDesignRequest(request);
      return out(202, {
        reviewRequired: true,
        designRequestId: request.id,
        status: "Open",
        reasons,
        occasion,
        eventDate: dateText,
        total,
        // How many business days staff promise to be in touch within.
        responseDays: settings.requestResponseDays,
        // The specific rule, for staff only.
        ...(staff ? { reviewReason: review.sentence } : {}),
        message: "This one goes to our team first. Nothing is held yet; we'll be in touch to put it together with you.",
      });
    }
  }

  // Block T1: which agreement this booking takes. The review rules above
  // already sent tier 3 to staff, so this is 1 or 2. A storefront hold must
  // match the tier it was told; a tier 2 hold carries a signature on a quote
  // that still has to hash the same today.
  const tierRules = { review: reviewRulesOf(settings), contractRequiredOver: settings.contractRequiredOver, contractRequiredForCrewed: settings.contractRequiredForCrewed };
  const crewed = items.some((item) => needsCrew(item));
  const decided = decideTier({ total, occasion, packageOccasions: pkg?.occasions ?? [], crewed }, tierRules);
  // Block F2: a request staff turn into a booking takes the policy or the
  // contract path by the same price and crew rule as any booking. It is no
  // longer forced to a contract.
  const tier: Tier = designRequestId ? baseTier({ total, crewed }, tierRules).tier : decided.tier;
  let quote: UsableQuote | null = null;
  let cartForQuote: QuoteCart | null = null;
  if (!staff) {
    if (input.tier !== undefined && input.tier !== null && input.tier !== tier) {
      return out(409, { error: QUOTE_CHANGED, reason: "tier-changed", tier });
    }
    if (tier === 2) {
      if (!input.signature) return out(400, { error: "This booking needs the signed GO contract. Read and sign it to continue.", reason: "agreement-required", tier });
      cartForQuote = {
        itemIds: [...itemIds].sort(),
        packageId: pkg?.id ?? null,
        addons: selections.size > 0 ? Object.fromEntries([...selections.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].sort()])) : null,
        eventDate: dateText,
        eventTime,
        occasion,
        guestCount,
      };
      const resolved = await resolveCart(account.id, cartForQuote);
      const check = await checkQuote(account.id, input.signature.quoteId, input.signature.contentHash, cartForQuote, resolved);
      if (!check.ok) return out(409, { error: check.message, reason: check.reason, tier });
      quote = check.quote;
    } else if (input.signature) {
      // A signature on a cart that no longer needs a contract: the tier
      // moved under the customer. Start them over rather than keep a
      // contract they did not need.
      return out(409, { error: QUOTE_CHANGED, reason: "tier-changed", tier });
    }
  }
  const delivery = input.delivery ?? null;
  const signer = tier === 2 ? await loadGoSigner(account.id) : null;

  // An item is promisable through its units, through the crew for its
  // skills, or both. One with neither can't be promised at all.
  const untracked = items.filter((item) => item._count.units === 0 && !needsCrew(item));
  if (untracked.length > 0) {
    return out(409, {
      error:
        untracked.length === 1
          ? "This item isn't available for direct booking yet."
          : `${untracked.map((item) => item.name).join(", ")} aren't available for direct booking yet.`,
      reason: "not-tracked",
      itemIds: untracked.map((item) => item.id),
    });
  }
  // "Snow Cone Station, Flavor: Peach (+$10); Size: Large (+$50)"
  const addonNote = items
    .map((item) => {
      const picks = addonRows.filter((a) => a.itemId === item.id);
      return picks.length === 0 ? null : `${item.name}, ${picks.map(describeAddon).join("; ")}`;
    })
    .filter((line): line is string => line !== null)
    .join(". ");

  const origin = staff ? "taken by staff in the admin" : "from the storefront";
  const leadContact = [contact.phone, contact.email].filter(Boolean).join(" · ");
  const when = eventTime ? `${dateText} at ${eventTime}` : dateText;
  const where = address ? ` Address: ${address}.` : " Address not given yet.";

  // Block F3a: which lead this booking belongs to. Staff named one, or a
  // storefront booking (or a storefront request being converted) has the
  // same email or phone as a lead that is still open (matchLead in
  // server/inbox.ts has the rule). Otherwise it gets its own lead, as before.
  let linkLeadId: string | null = null;
  let nearLeads: { id: string; customerName: string | null; createdAt: Date }[] = [];
  if (staff && input.leadId) {
    const named = await prisma.lead.findFirst({ where: { id: input.leadId, accountId: account.id }, select: { id: true } });
    if (!named) return out(404, { error: "That lead was not found.", reason: "lead-not-found" });
    linkLeadId = named.id;
  } else if (!staff || designRequestId) {
    const match = await findLeadMatch(account.id, { name, email: contact.email, phone: contact.phone });
    linkLeadId = match.exact?.id ?? null;
    nearLeads = match.near;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock every unit before writing anything: the wanted quantity of
      // each item, each lock skipping the units this transaction already
      // holds. An item short by even one unit is collected so the message
      // can name all of them.
      const claimed: { item: (typeof items)[number]; unit: { id: string; label: string } }[] = [];
      const missing: string[] = [];
      for (const { item, quantity } of wanted) {
        if (item._count.units === 0) continue;
        const held: string[] = [];
        for (let n = 0; n < quantity; n++) {
          const unit = await lockFreeUnit(tx, item.id, dateText, held);
          if (!unit) break;
          held.push(unit.id);
          claimed.push({ item, unit });
        }
        if (held.length < quantity) missing.push(item.name);
      }
      if (missing.length > 0) throw new NoFreeUnits(missing);

      const crewItems = wanted.filter(({ item }) => needsCrew(item));
      const summary = [
        ...claimed.map(({ item, unit }) => `${item.name} (${unit.label})`),
        ...crewItems
          .filter(({ item }) => item._count.units === 0)
          .map(({ item, quantity }) => (quantity > 1 ? `${item.name} x${quantity} (crew)` : `${item.name} (crew)`)),
      ].join(", ");
      const packageNote = pkg ? ` Package: ${pkg.name}, $${Number(pkg.price)}.` : "";
      // An existing lead keeps everything on it (its source, its notes, its
      // history); only its column moves to Booked and an empty date is filled.
      const linked = linkLeadId ? await tx.lead.findFirst({ where: { id: linkLeadId, accountId: account.id } }) : null;
      const lead = linked
        ? await tx.lead.update({ where: { id: linked.id }, data: { status: leadStatus, sortOrder: 0, dateOfInterest: linked.dateOfInterest ?? date, followUpOn: null, followUpNote: null } })
        : await tx.lead.create({
            data: {
              accountId: account.id,
              source: staff ? "manual" : "storefront",
              status: leadStatus,
              customerName: name,
              contact: leadContact,
              occasion: pkg ? pkg.name : [...new Set(claimed.map(({ item }) => item.name))].join(", "),
              dateOfInterest: date,
              notes: `Direct booking of ${summary} ${origin}, ${when}.${where}${packageNote}${addonNote ? ` Add-ons: ${addonNote}.` : ""}`,
            },
          });
      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          kind: "status",
          text: `Booked ${summary} for ${when} ${origin}.${addonNote ? ` Add-ons: ${addonNote}.` : ""}${linked ? (staff && input.leadId ? " Built from this lead." : " Linked to this lead because the email or phone is the same.") + (linked.status !== leadStatus ? ` Moved to ${leadStatus}.` : "") : ""}`,
          ...actorFields(),
        },
      });
      const booking = await tx.booking.create({
        data: {
          accountId: account.id,
          leadId: lead.id,
          customerId: customer?.id ?? null,
          eventDate: date,
          eventTime,
          address,
          eventAddressSameAsHome: input.eventAddressSameAsHome === true,
          // The per-guest count a package was priced on. A request staff turn
          // into a booking also keeps the count the customer gave with it.
          guestCount: guestCount ?? (designRequestId ? (input.guestCount ?? null) : null),
          customerName: name,
          phone: contact.phone,
          email: contact.email,
          status: "Held",
          // Block F3a: where it was made, now that its lead may have come
          // from somewhere else.
          origin: staff ? "staff" : "storefront",
          rush,
          occasion,
          balancePaymentPreference,
          packageId: pkg?.id ?? null,
          total,
          tier,
          ...(input.place
            ? // Block A9: the exact place from Google, verified now.
              placeColumns(input.place, delivery ? { setupLat: delivery.setupLat, setupLng: delivery.setupLng, setupNotes: delivery.setupNotes } : (input.pin ?? null))
            : {
                ...deliveryColumns(delivery),
                // The contract's mailing address comes from the delivery
                // address when there is one.
                ...(delivery ? { mailingAddress: `${delivery.components.streetNumber} ${delivery.components.route}`.trim(), city: delivery.components.city || null, state: delivery.components.state || null, zip: delivery.components.zip || null } : {}),
                ...(address && input.addressCheckReason ? { addressCheck: "not_checked", addressCheckReason: input.addressCheckReason } : {}),
                // A converted request whose address staff changed: the pin no
                // longer fits, the customer's setup notes still do.
                ...(!delivery && input.pin?.setupNotes ? { setupNotes: input.pin.setupNotes } : {}),
              }),
          // eventDate is copied onto each join row for the (unitId, eventDate)
          // unique constraint, the database-level backstop behind the lock.
          units: { create: claimed.map(({ unit }) => ({ unitId: unit.id, eventDate: date })) },
          // Names and the delta are copied so the booking stays readable
          // and honest if the option is later renamed, repriced, or removed.
          addons: {
            create: addonRows.map((a) => ({
              itemId: a.itemId,
              addonId: a.addonId,
              itemName: a.itemName,
              groupName: a.groupName,
              addonName: a.addonName,
              priceDelta: a.priceDelta,
              quantity: a.quantity,
            })),
          },
        },
      });
      // One gig per skill per unit wanted of each item that needs crew,
      // after every unit lock above (units first, then skills in order,
      // so the lock order is the same in every transaction). A skill with
      // nobody free on the date throws and rolls the whole booking back,
      // the same as an item with no free unit.
      const gigs = await createGigs(tx, { accountId: account.id, bookingId: booking.id, date, wanted: crewItems });
      // First booking from an account that signed up without a name: keep
      // the name so the next booking doesn't ask again.
      if (customer && !customer.name) {
        await tx.customer.update({ where: { id: customer.id }, data: { name } });
      }
      // The agreement is written in the same transaction as the booking;
      // the database refuses to commit a booking without one.
      const agreement = await tx.agreement.create({
        data: {
          accountId: account.id,
          customerId: customer?.id ?? null,
          bookingId: booking.id,
          policyVersionId: policy.id,
          checkboxChecked,
          ...evidence,
          // A tier 2 hold is the GO contract, prepared, sent (at checkout)
          // and signed by the customer in one go; GO's signature is the one
          // the quote carried.
          ...(quote
            ? {
                format: "go-v2",
                termsVersionId: quote.termsVersionId,
                contractProvider: "self-hosted",
                signingToken: token(),
                contractStatus: "Sent",
                contractSentAt: quote.goSignedAt,
                goSignerName: signer?.name ?? null,
                goSignedAt: signer ? quote.goSignedAt : null,
                quoteId: quote.id,
                confirmByDate: quote.confirmByDate,
              }
            : {}),
        },
      });
      if (quote) await tx.quote.update({ where: { id: quote.id }, data: { usedByBookingId: booking.id } });
      // Converting a design request: claim it under a row lock so two
      // people can't both turn it into a booking, then link the two.
      if (designRequestId) {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM design_requests WHERE id = ${designRequestId} AND account_id = ${account.id} FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== "Open") throw new DesignRequestUnavailable();
        await tx.designRequest.update({ where: { id: designRequestId }, data: { status: "Converted", bookingId: booking.id } });
      }
      return { booking, lead, claimed, gigs, agreement };
    });

    // A request that became a booking. On the contract path the customer is
    // sent their contract link, after the booking is safely committed and
    // never in the way of its response. On the policy path there is no
    // contract to send. Either way its bell alerts are cleared.
    //
    // Block F1: every booking staff make (a converted request or a new one)
    // sends the customer what they owe next, with the amount: on the contract
    // path the contract link, on the policy path the pay link. sendPayLink
    // decides which, and goes through sendContract for the contract. Waited
    // on so the reply can say whether it went.
    let payLinkSend: PayLinkSend | null = null;
    if (staff && input.sendPayLink !== false) payLinkSend = await sendPayLink(result.booking.id, "created");
    if (designRequestId) void clearRequestAlerts(designRequestId);

    // Block T1. A tier 2 hold: the signature taken in checkout is recorded
    // now, against the quote's hash, and the signed document and PDF are
    // stored. A failure here leaves the booking held with the contract
    // prepared (staff can send the link); the customer's hold is never lost.
    let contract: { agreementId: string; signed: boolean; signedAt: string | null; pdfUrl: string | null } | null = null;
    if (quote && input.signature) {
      contract = { agreementId: result.agreement.id, signed: false, signedAt: null, pdfUrl: null };
      try {
        const signed = await signContractFromQuote(
          result.agreement.id,
          {
            fullName: input.signature.fullName,
            additionalSignerName: input.signature.additionalSignerName,
            consentToElectronicSignature: true,
            agreeToTerms: true,
            ip: input.request?.ip ?? null,
            userAgent: input.request?.userAgent ?? null,
          },
          quote.contentHash,
        );
        contract = { agreementId: result.agreement.id, signed: true, signedAt: signed.signedAt.toISOString(), pdfUrl: signed.pdfUrl };
        // Block F1: signed at checkout, so the retainer is asked for now (the
        // pay step is the next screen). Nothing is sent this minute; if they
        // leave without paying, the retainer reminders carry the pay link.
        await prisma.booking.updateMany({ where: { id: result.booking.id, retainerRequestedAt: null }, data: { retainerRequestedAt: new Date() } });
        void notifyContractSigned({ bookingId: result.booking.id, designRequestId: null }, signed);
      } catch (err) {
        console.error("[bookings] checkout signature could not be recorded:", safeErr(err));
      }
    }
    // What to collect now: the retainer (or, for a small rental set to collect
    // in full, the whole amount). Null when online payment is not set up or
    // the session could not be made; the booking stands either way.
    let payment: PaymentOffer | null = null;
    if (!staff && total !== null && total > 0) {
      try {
        payment = await createPaymentSession(result.booking.id, "retainer");
      } catch (err) {
        console.warn("[bookings] no payment session for the hold:", safeErr(err));
      }
    }
    const fresh = await prisma.booking.findUniqueOrThrow({ where: { id: result.booking.id }, select: { status: true, retainerPaid: true, tier: true, confirmedAt: true } });
    // Block A9: a storefront hold was looked up before it was made. A staff
    // booking is checked after the reply, never refused, never waited on.
    // The calendar follows a signed contract.
    if (staff && address && !input.place) void checkBookingAddress(result.booking.id).catch(() => undefined);
    if (contract?.signed) queueGoogleSync(result.booking.id);
    // Staff made this one themselves, so only a storefront hold is news.
    if (!staff) {
      if (linkLeadId) await notifyLinkedBooking({ leadId: result.lead.id, accountId: account.id, customerName: name, leadSource: result.lead.source, bookingId: result.booking.id, customerId: result.booking.customerId });
      else await notifyNewLead({ ...result.lead, bookingId: result.booking.id, customerId: result.booking.customerId });
    }
    // Block F3a: a near match is never linked on its own. Both leads say so.
    if (!linkLeadId && nearLeads.length > 0) void notePossibleMatches(result.lead.id, name, nearLeads);

    // One entry per unit held and one per gig, so an item wanted twice
    // appears twice. A gig has no unit; its entry says so with null.
    const bookedItems = [
      ...result.claimed.map(({ item, unit }) => ({
        id: item.id,
        name: item.name,
        unit: { id: unit.id, label: unit.label } as { id: string; label: string } | null,
      })),
      // A skill-only item has no unit; one entry per unit wanted, not per
      // gig, so an item needing three people still appears once.
      ...result.gigs
        .filter((g, i, all) => all.findIndex((x) => x.itemId === g.itemId) === i)
        .flatMap((g) => {
          const w = wanted.find(({ item }) => item.id === g.itemId);
          if (!w || w.item._count.units > 0) return [];
          return Array.from({ length: w.quantity }, () => ({ id: g.itemId, name: g.itemName, unit: null }));
        }),
    ];
    return out(201, {
      bookingId: result.booking.id,
      // Internal records (the CRM lead, the crew gigs) are for staff. The
      // storefront reads neither, so the public reply does not carry them.
      ...(staff ? { leadId: result.lead.id } : {}),
      customerId: result.booking.customerId,
      eventDate: dateText,
      eventTime: result.booking.eventTime,
      address: result.booking.address,
      // Block A9: the exact place on Google Maps, when the address was found.
      mapsUrl: bookingMapsUrl(result.booking),
      phone: result.booking.phone,
      email: result.booking.email,
      // status keeps the meaning the storefront reads (live = "Confirmed");
      // stage is the real one, depositPaid the old name for retainerPaid.
      status: legacyCustomerStatus(fresh.status),
      stage: staff ? displayStatus(fresh) : customerStage(fresh),
      tier,
      payment,
      contract,
      // True when the event starts inside the minimum notice window; the
      // booking is complete either way, this is so the storefront can say
      // it is pending confirmation.
      rush: result.booking.rush,
      occasion: result.booking.occasion,
      balancePaymentPreference: result.booking.balancePaymentPreference,
      agreement: {
        id: result.agreement.id,
        policyVersion: policy.version,
        policyVersionId: policy.id,
        checkboxChecked: result.agreement.checkboxChecked,
        agreedAt: result.agreement.agreedAt.toISOString(),
      },
      depositPaid: result.booking.retainerPaid,
      total,
      addonsTotal,
      addons: addonRows,
      packageId: pkg?.id ?? null,
      package: pkg ? { id: pkg.id, name: pkg.name, price: Number(pkg.price) } : null,
      // item and unit are the first entry, kept for single-item callers;
      // items has every unit held, so an item wanted twice appears twice.
      item: { id: bookedItems[0].id, name: bookedItems[0].name },
      unit: bookedItems[0].unit,
      items: bookedItems,
      ...(staff ? { gigs: result.gigs } : {}),
      // Block F1: whether the customer was sent what they owe, and if not, why.
      ...(staff && payLinkSend ? { payLink: { sent: payLinkSend.sent, step: payLinkSend.step, amountCents: payLinkSend.amountCents, why: payLinkSend.why } } : {}),
    });
  } catch (err) {
    if (err instanceof DesignRequestUnavailable) {
      return out(409, { error: "That design request was already turned into a booking or dismissed.", reason: "request-unavailable" });
    }
    // NoFreeUnits is the normal loser path. P2002 is the (unitId, eventDate)
    // unique constraint firing anyway, which the lock should make
    // impossible here; it's handled the same way rather than as a 500.
    if (err instanceof NoFreeUnits || err instanceof NoCrewFree) {
      const names = err instanceof NoFreeUnits ? err.itemNames : [err.itemName];
      return out(409, {
        error:
          items.length === 1 && err instanceof NoCrewFree
            ? `Nobody on the crew is free to cover the ${err.skill} for ${err.itemName} that date. Try another date.`
            : items.length === 1
            ? "That date was just booked by someone else. Try another date."
            : `${names.join(", ")} ${names.length === 1 ? "isn't" : "aren't"} available that date, so nothing was booked. Drop ${names.length === 1 ? "it" : "them"} or try another date.`,
        reason: "unavailable",
        unavailable: names,
      });
    }
    if ((err as { code?: unknown }).code === "P2002") {
      return out(409, {
        error: "That date was just booked by someone else. Try another date.",
        reason: "unavailable",
      });
    }
    throw err;
  }
}

// Block F3a. A new booking looks like it could belong to a lead that already
// exists (the same name with other contact details, or the same contact on a
// lead that is closed or already booked). Nothing is merged: each lead gets a
// line in its history and the tag "Possible duplicate", for a person to judge.
export const DUPLICATE_TAG = "Possible duplicate";
async function notePossibleMatches(newLeadId: string, name: string, near: { id: string; customerName: string | null; createdAt: Date }[]): Promise<void> {
  try {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const tag = async (id: string) => {
      const l = await prisma.lead.findUnique({ where: { id }, select: { tags: true } });
      if (l && !l.tags.includes(DUPLICATE_TAG)) await prisma.lead.update({ where: { id }, data: { tags: [...l.tags, DUPLICATE_TAG] } });
    };
    await tag(newLeadId);
    await prisma.leadActivity.create({ data: { leadId: newLeadId, kind: "status", text: `Possible match with ${near.length === 1 ? "an earlier lead" : `${near.length} earlier leads`}: ${near.map((n) => `${n.customerName ?? "no name"} (added ${day(n.createdAt)})`).join(", ")}. Not linked, because the email and phone are not the same or that lead is closed or already booked.` } });
    for (const n of near) {
      await tag(n.id);
      await prisma.leadActivity.create({ data: { leadId: n.id, kind: "status", text: `Possible match: a new booking was made for ${name}. It was not linked to this lead. Check whether they are the same customer.` } });
    }
  } catch (err) {
    console.warn("[bookings] possible matches not noted:", safeErr(err));
  }
}
