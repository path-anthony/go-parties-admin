import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { parseAddonSelections } from "../addons.js";
import { currentCustomer } from "../customerAuth.js";
import { botCheck } from "../botCheck.js";
import { createDirectBooking, MAX_UNITS_PER_BOOKING, type HoldSignature } from "../directBooking.js";
import { isInvalidDelivery, parseDelivery } from "../delivery.js";
import { prettyPhone } from "../messageContext.js";
import { safeInline, stripControl } from "../sanitize.js";
import { getSettings } from "../settings.js";
import { refundDaily, takeDaily } from "../usage.js";
import { prisma } from "../db.js";
import { BALANCE_PREFERENCES } from "../../src/lib/bookingStatus.js";
import { canonicalOccasion } from "../../src/lib/occasions.js";
import { INVALID, looksLikeEmail, normalizeDate, normalizeText, splitContact, todayEastern } from "../validate.js";

const MAX_ADDRESS_LENGTH = 300;
const MAX_NAME_LENGTH = 100;
const MAX_TIME_LENGTH = 60;
const MAX_ITEMS_PER_BOOKING = 10;

const router = Router();

// Contact comes one of two ways. phone and email as separate fields, both
// required, is the contract. A single legacy "contact" is still accepted
// and sorted into phone or email by shape (the other side stays null), so
// a storefront build that still sends one field keeps working until it
// collects both. Sending phone or email means both must be present. A
// signed-in customer can leave all of it out and their account fills it.
//
// Whatever arrives is capped and stripped of control characters before it is
// stored: these values are shown to staff and used as the recipient of texts
// and emails. On the public form (strict) they also have to look like a phone
// number and an email address, so a booking can't be made with junk in them.
const MAX_PHONE_LENGTH = 40;
const MAX_EMAIL_LENGTH = 200;

function resolveContact(
  body: Record<string, unknown>,
  fallback: { phone: string; email: string } | null,
  strict = false,
): { phone: string | null; email: string | null } | string {
  if ("phone" in body || "email" in body) {
    if ((typeof body.phone === "string" && body.phone.length > 200) || (typeof body.email === "string" && body.email.length > 400)) return "phone or email is too long";
    const phone = stripControl(normalizeText(body.phone), MAX_PHONE_LENGTH) || null;
    const email = stripControl(normalizeText(body.email), MAX_EMAIL_LENGTH) || null;
    if (!phone || !email) return "phone and email are both required";
    if (strict) {
      const digits = phone.replace(/\D/g, "").length;
      if (digits < 7 || digits > 15) return "phone must be a phone number";
      if (!looksLikeEmail(email)) return "email must be an email address";
    }
    return { phone, email };
  }
  const contact = stripControl(normalizeText(body.contact), MAX_EMAIL_LENGTH) || null;
  if (contact) return splitContact(contact);
  if (fallback) return fallback;
  return "phone and email are required";
}

// The tier 2 signature as the storefront sends it with the hold: the typed
// name (first and last), an optional second signer, consent, and the quote it
// was given on.
function resolveSignature(value: unknown): HoldSignature | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "signature must be an object";
  const s = value as Record<string, unknown>;
  const fullName = typeof s.fullName === "string" ? safeInline(s.fullName, 120).replace(/\s+/g, " ") : "";
  if (fullName.length < 3 || !fullName.includes(" ")) return "Type your full name, first and last, to sign.";
  let additionalSignerName: string | null = null;
  if (s.additionalSignerName !== undefined && s.additionalSignerName !== null && s.additionalSignerName !== "") {
    if (typeof s.additionalSignerName !== "string") return "additionalSignerName must be text";
    additionalSignerName = safeInline(s.additionalSignerName, 120) || null;
  }
  if (s.esignConsent !== true) return "You need to consent to sign electronically to continue.";
  if (typeof s.contentHash !== "string" || !/^[a-f0-9]{16,128}$/i.test(s.contentHash)) return "signature.contentHash must be the quote's hash";
  if (typeof s.quoteId !== "string" || s.quoteId === "" || s.quoteId.length > 60) return "signature.quoteId must be the quote id";
  return { fullName, additionalSignerName, contentHash: s.contentHash, quoteId: s.quoteId };
}

function optionalText(value: unknown, max: number): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const text = value.trim();
  if (text === "") return null;
  return text.length <= max ? text : INVALID;
}

// Optional. A group (Wedding) or sub-occasion, in the known spelling.
function resolveOccasion(body: Record<string, unknown>): string | null | typeof INVALID {
  const { occasion } = body;
  if (occasion === undefined || occasion === null || occasion === "") return null;
  if (typeof occasion !== "string") return INVALID;
  return canonicalOccasion(occasion) ?? INVALID;
}

function resolveBalancePreference(body: Record<string, unknown>): string | typeof INVALID {
  const { balancePaymentPreference: pref } = body;
  if (pref === undefined || pref === null || pref === "") return "Manual";
  return typeof pref === "string" && (BALANCE_PREFERENCES as readonly string[]).includes(pref) ? pref : INVALID;
}

// itemId (one item) is the original contract and keeps working as is.
// itemIds (several) is additive. Sending both is ambiguous, so it's
// refused rather than merged.
function resolveItemIds(body: Record<string, unknown>): string[] | string {
  const { itemId, itemIds } = body;
  if (itemIds !== undefined && itemId !== undefined) return "send itemId or itemIds, not both";
  if (itemIds !== undefined) {
    if (!Array.isArray(itemIds) || itemIds.length === 0 || !itemIds.every((id): id is string => typeof id === "string" && id !== "")) {
      return "itemIds must be a non-empty array of item ids";
    }
    const unique = [...new Set(itemIds)];
    if (unique.length > MAX_ITEMS_PER_BOOKING) return `itemIds can hold at most ${MAX_ITEMS_PER_BOOKING} items`;
    return unique;
  }
  if (typeof itemId === "string" && itemId !== "") return [itemId];
  return "itemId or itemIds is required";
}

// Optional. When present it has to be a real Published package on the
// account, and the items being booked have to be exactly the package's
// items (no extras, none missing), so the bundle price can't be applied
// to a different cart. The package's quantities then decide how many
// units of each item are held, and its price is the booking's total.
function resolvePackageId(body: Record<string, unknown>): string | null | typeof INVALID {
  const { packageId } = body;
  if (packageId === undefined || packageId === null) return null;
  return typeof packageId === "string" && packageId !== "" ? packageId : INVALID;
}

// Public, no session required, rate limited where it's mounted. A customer
// books one or more specific items for one date. One free unit per item
// (or, from a package, the package's quantity of each) is picked and locked
// (SKIP LOCKED) inside the same transaction that writes the Booking, its
// BookingUnit rows, and the CRM Lead: either every item gets its units or
// the whole request rolls back with nothing booked, and two requests racing
// for the last unit of any item can't both succeed. If a customer session
// is present the booking is attached to that account and name, phone, and
// email default from it.
//
// addons is optional: { [itemId]: [addonId, ...] }. Every addon has to
// belong to the item it's sent under, a group takes one choice, and an
// item's required groups have to be answered or the booking is refused.
// Each chosen option's price delta (times the units held of that item) is
// added to the total, and the choices are stored as BookingAddon rows with
// their names, so they read as choices in the admin, not as a bigger number.
router.post("/", botCheck("direct-booking"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const customer = await currentCustomer(req);
  // Names and free text from the public form are cleaned before they are
  // stored, because they end up in texts and emails we send: no links, no
  // control characters, a sane length.
  const name = safeInline(normalizeText(body.customerName), MAX_NAME_LENGTH) || (customer?.name ? safeInline(customer.name, MAX_NAME_LENGTH) : null) || null;
  if (!name) {
    return res.status(400).json({
      error: customer ? "customerName is required the first time; it's saved to your account after that" : "customerName is required",
    });
  }
  const contact = resolveContact(body, customer ? { phone: customer.phone, email: customer.email } : null, true);
  if (typeof contact === "string") {
    return res.status(400).json({ error: contact });
  }
  const itemIds = resolveItemIds(body);
  if (typeof itemIds === "string") {
    return res.status(400).json({ error: itemIds });
  }
  const date = normalizeDate(body.eventDate);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  }
  const dateText = date.toISOString().slice(0, 10);
  if (dateText < todayEastern()) {
    return res.status(400).json({ error: "eventDate can't be in the past" });
  }
  const address = optionalText(body.address, MAX_ADDRESS_LENGTH);
  if (address === INVALID) {
    return res.status(400).json({ error: `address must be text up to ${MAX_ADDRESS_LENGTH} characters` });
  }
  const eventTime = optionalText(body.eventTime, MAX_TIME_LENGTH);
  if (eventTime === INVALID) {
    return res.status(400).json({ error: `eventTime must be text up to ${MAX_TIME_LENGTH} characters` });
  }
  const cleanAddress = address === null ? null : safeInline(address, MAX_ADDRESS_LENGTH) || null;
  const cleanTime = eventTime === null ? null : safeInline(eventTime, MAX_TIME_LENGTH) || null;
  const selections = parseAddonSelections(body.addons, itemIds);
  if (typeof selections === "string") {
    return res.status(400).json({ error: selections, reason: "addon-invalid" });
  }
  const packageId = resolvePackageId(body);
  if (packageId === INVALID) {
    return res.status(400).json({ error: "packageId must be a package id" });
  }

  const occasion = resolveOccasion(body);
  if (occasion === INVALID) {
    return res.status(400).json({ error: "occasion must be a known occasion, like Wedding or Sweet 16" });
  }
  const balancePaymentPreference = resolveBalancePreference(body);
  if (balancePaymentPreference === INVALID) {
    return res.status(400).json({ error: `balancePaymentPreference must be one of ${BALANCE_PREFERENCES.join(", ")}` });
  }
  if (body.agreedToPolicy !== undefined && typeof body.agreedToPolicy !== "boolean") {
    return res.status(400).json({ error: "agreedToPolicy must be true or false" });
  }
  // Block T1: the tier the storefront was told, the tier 2 signature and
  // the delivery location, each optional and checked for shape here.
  let tier: 1 | 2 | 3 | null = null;
  if (body.tier !== undefined && body.tier !== null) {
    if (body.tier !== 1 && body.tier !== 2 && body.tier !== 3) return res.status(400).json({ error: "tier must be 1, 2 or 3" });
    tier = body.tier;
  }
  const signature = resolveSignature(body.signature);
  if (typeof signature === "string") return res.status(400).json({ error: signature, reason: "signature-invalid" });
  const delivery = parseDelivery(body.delivery);
  if (isInvalidDelivery(delivery)) return res.status(400).json({ error: delivery.invalid, reason: "delivery-invalid" });
  // The plain address is the verified one whenever a delivery was sent.
  const addressForBooking = delivery ? delivery.formattedAddress : cleanAddress;

  // Site-wide cap on storefront bookings per day. Staff bookings are not
  // counted or limited. A slot is taken here in one atomic step (so a burst
  // of requests cannot all slip under the cap) and given back below if no
  // booking or design request came of it.
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  if (!(await takeDaily(account.id, "direct_booking", settings.directBookingDailyCap))) {
    const phone = prettyPhone(settings.rushContactPhone ?? process.env.TWILIO_PHONE_NUMBER);
    console.warn("[bookings] storefront daily cap reached");
    return res.status(429).json({
      error: `We're taking bookings by phone for the rest of today. Call or text us${phone ? ` at ${phone}` : ""}.`,
      reason: "daily-cap",
    });
  }

  let result: Awaited<ReturnType<typeof createDirectBooking>>;
  try {
    result = await createDirectBooking({
      staff: false,
      occasion,
      balancePaymentPreference,
      agreed: body.agreedToPolicy === true,
      name,
      contact,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      itemIds,
      date,
      dateText,
      eventTime: cleanTime,
      address: addressForBooking,
      selections,
      packageId,
      // Kept with the agreement: who ticked the box, as far as the request shows.
      request: { ip: req.ip, userAgent: req.get("user-agent") },
      tier,
      signature,
      delivery,
    });
  } catch (err) {
    await refundDaily(account.id, "direct_booking").catch(() => undefined);
    throw err;
  }
  if (result.status !== 201 && result.status !== 202) await refundDaily(account.id, "direct_booking");
  res.status(result.status).json(result.body);
});

export default router;

// The admin's New booking: the same booking, taken on a customer's behalf
// by staff. It goes through createDirectBooking, so the unit locks, crew
// checks, add-on rules, lead and RUSH flag are the storefront's exactly.
// Differences: it needs the admin session (mounted behind it), it adds a
// quantity per item, it can attach an existing customer's account (found
// with GET /api/customers?q=) or take contact details inline with no
// account, and it can confirm a price other than the computed one.
export const staffBookingRouter = Router();

staffBookingRouter.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const account = await getDefaultAccount();
  let customer: { id: string; name: string | null; phone: string; email: string } | null = null;
  if (body.customerId !== undefined && body.customerId !== null && body.customerId !== "") {
    customer =
      typeof body.customerId === "string"
        ? await prisma.customer.findFirst({ where: { id: body.customerId, accountId: account.id }, select: { id: true, name: true, phone: true, email: true } })
        : null;
    if (!customer) return res.status(400).json({ error: "customerId must be a customer on this account" });
  }
  const name = normalizeText(body.customerName) ?? customer?.name ?? null;
  if (!name) return res.status(400).json({ error: "customerName is required" });
  const contact = resolveContact(body, customer ? { phone: customer.phone, email: customer.email } : null);
  if (typeof contact === "string") return res.status(400).json({ error: contact });

  const itemIds = resolveItemIds(body);
  if (typeof itemIds === "string") return res.status(400).json({ error: itemIds });
  const quantities: Record<string, number> = {};
  if (body.quantities !== undefined) {
    const q = body.quantities;
    if (typeof q !== "object" || q === null || Array.isArray(q)) return res.status(400).json({ error: "quantities must be { [itemId]: number }" });
    for (const [id, n] of Object.entries(q)) {
      if (!itemIds.includes(id)) return res.status(400).json({ error: "quantities can only name items being booked" });
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_UNITS_PER_BOOKING) {
        return res.status(400).json({ error: `each quantity must be a whole number from 1 to ${MAX_UNITS_PER_BOOKING}` });
      }
      quantities[id] = n;
    }
  }
  const date = normalizeDate(body.eventDate);
  if (date === null || date === INVALID) return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  const dateText = date.toISOString().slice(0, 10);
  if (dateText < todayEastern()) return res.status(400).json({ error: "eventDate can't be in the past" });
  const address = optionalText(body.address, MAX_ADDRESS_LENGTH);
  if (address === INVALID) return res.status(400).json({ error: `address must be text up to ${MAX_ADDRESS_LENGTH} characters` });
  const eventTime = optionalText(body.eventTime, MAX_TIME_LENGTH);
  if (eventTime === INVALID) return res.status(400).json({ error: `eventTime must be text up to ${MAX_TIME_LENGTH} characters` });
  const selections = parseAddonSelections(body.addons, itemIds);
  if (typeof selections === "string") return res.status(400).json({ error: selections, reason: "addon-invalid" });
  const packageId = resolvePackageId(body);
  if (packageId === INVALID) return res.status(400).json({ error: "packageId must be a package id" });

  const occasion = resolveOccasion(body);
  if (occasion === INVALID) return res.status(400).json({ error: "occasion must be a known occasion, like Wedding or Sweet 16" });
  const balancePaymentPreference = resolveBalancePreference(body);
  if (balancePaymentPreference === INVALID) return res.status(400).json({ error: `balancePaymentPreference must be one of ${BALANCE_PREFERENCES.join(", ")}` });
  if (body.agreed !== true) {
    return res.status(400).json({ error: "Confirm that the customer agreed to the cancellation and retainer policy.", reason: "agreement-required" });
  }
  let designRequestId: string | null = null;
  if (body.designRequestId !== undefined && body.designRequestId !== null && body.designRequestId !== "") {
    if (typeof body.designRequestId !== "string") return res.status(400).json({ error: "designRequestId must be a design request id" });
    const request = await prisma.designRequest.findFirst({ where: { id: body.designRequestId, accountId: account.id }, select: { status: true } });
    if (!request) return res.status(404).json({ error: "design request not found" });
    if (request.status !== "Open") return res.status(409).json({ error: "That design request was already turned into a booking or dismissed.", reason: "request-unavailable" });
    designRequestId = body.designRequestId;
  }

  let totalOverride: number | null | undefined;
  if (body.total !== undefined) {
    if (body.total === null) totalOverride = null;
    else if (typeof body.total === "number" && Number.isFinite(body.total) && body.total >= 0) totalOverride = Math.round(body.total * 100) / 100;
    else return res.status(400).json({ error: "total must be a number of 0 or more, or null" });
  }

  const result = await createDirectBooking({
    staff: true,
    occasion,
    balancePaymentPreference,
    agreed: true,
    designRequestId,
    name,
    contact,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    itemIds,
    quantities,
    date,
    dateText,
    eventTime,
    address,
    selections,
    packageId,
    totalOverride,
  });
  res.status(result.status).json(result.body);
});
