import bcrypt from "bcryptjs";
import { Router } from "express";
import type { Customer } from "../../src/generated/prisma/client.js";
import { getDefaultAccount } from "../account.js";
import {
  NoFreeUnit,
  changeBookingItem,
  rescheduleBooking,
  serializeCustomerBooking,
} from "../bookingOps.js";
import {
  endCustomerSession,
  normalizeEmail,
  normalizePhone,
  phoneRefusal,
  usPhoneDigits,
  passwordProblem,
  publicCustomer,
  requireCustomer,
  startCustomerSession,
} from "../customerAuth.js";
import { prisma } from "../db.js";
import { safeInline } from "../sanitize.js";
import { queueGoogleSync } from "../google/sync.js";
import { BOOKING_GIGS_SELECT, NoCrewFree } from "../gigs.js";
import { attemptLogin } from "../loginLimit.js";
import { customerActionLimiter, customerLoginLimiter, customerSignupLimiter } from "../rateLimit.js";
import { INVALID, normalizeDate, normalizeText, todayEastern } from "../validate.js";
import { ContractError, prepareContract, signContract } from "../contracts.js";
import { contractView, parseSignBody } from "./contracts.js";
import { notifyContractSigned } from "../notify.js";
import { PaymentError, createPaymentSession } from "../payments.js";
import { SELF_SERVE_REFUSAL, portalFields, selfServeAllowed } from "../portal.js";
import { MAX_REASON, cancellationPreview, requestCancellation, type RetainerTerms } from "../cancellations.js";
import { sendPayLink } from "../payLink.js";
import { getSettings } from "../settings.js";
import { bookingMapsUrl } from "../delivery.js";
import { StripeError } from "../stripe/client.js";
import { customerWeddingRouter } from "./weddingDetails.js";
import { NOT_EXACT_MESSAGE, lookupAddress } from "../addressLookup.js";
import { Prisma } from "../../src/generated/prisma/client.js";

const BCRYPT_ROUNDS = 12;
const MAX_TIME_LENGTH = 60;
const MAX_NAME_LENGTH = 100;
// The same limit as the booking's event address.
export const MAX_HOME_ADDRESS_LENGTH = 300;
// Same wording for an unknown identifier and a wrong password, so a login
// attempt can't be used to check whether an address has an account.
const BAD_LOGIN = "That phone or email and password don't match.";

const router = Router();

const WITH_UNIT_DETAILS = {
  units: { include: { unit: { include: { item: { select: { id: true, name: true } } } } } },
  addons: { orderBy: { createdAt: "asc" as const } },
  gigs: BOOKING_GIGS_SELECT,
  // Block T1: the contract and the money, for the portal's steps.
  agreement: { select: { id: true, format: true, signingToken: true, contractStatus: true, contractSentAt: true, contractUrl: true, contractDocument: { select: { signedAt: true, documentJson: true } } } },
  payments: { select: { kind: true, status: true, amountCents: true, refundedCents: true, paidAt: true }, orderBy: { createdAt: "asc" as const } },
  // Block F1: a cancellation request waiting on staff.
  cancellationRequests: { where: { status: "Open" }, select: { id: true, reason: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 1 },
} as const;

type PortalRow = Parameters<typeof serializeCustomerBooking>[0] & Parameters<typeof portalFields>[0];

async function portalSettings(accountId: string) {
  const s = await getSettings(accountId);
  return { depositPercentage: s.depositPercentage, tier1Collect: s.tier1Collect, balanceDueDays: s.balanceDueDays };
}

// The customer booking as the portal reads it: the original fields plus the
// Block T1 ones (tier, stage, steps, contract, money, delivery).
async function portalBooking(b: PortalRow) {
  return { ...serializeCustomerBooking(b), ...portalFields(b, await portalSettings(b.accountId)) };
}

// Block A5: an optional one-line home address, cleaned like a name since
// it is printed on records and in messages. Blank, null and absent clear
// it; anything else is text within the limit.
function parseHomeAddress(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const text = normalizeText(value);
  if (text === null) return null;
  if (text.length > MAX_HOME_ADDRESS_LENGTH) return INVALID;
  return safeInline(text, MAX_HOME_ADDRESS_LENGTH) || null;
}
const HOME_ADDRESS_ERROR = `homeAddress must be text up to ${MAX_HOME_ADDRESS_LENGTH} characters, or blank`;

// Block A9: the home address columns for a typed address. An exact match
// from Google is stored as Google writes it with its place; a clear "not
// exact" is refused (field homeAddress); when Google cannot answer the text
// is kept as typed with no place. Null clears everything.
type HomeColumns = { homeAddress: string | null; homePlaceId: string | null; homeLat: number | null; homeLng: number | null; homeComponents: Prisma.InputJsonObject | typeof Prisma.DbNull; homeCheckedAt: Date | null };
async function homeColumns(accountId: string, text: string | null): Promise<HomeColumns | { refused: true }> {
  const none: HomeColumns = { homeAddress: text, homePlaceId: null, homeLat: null, homeLng: null, homeComponents: Prisma.DbNull, homeCheckedAt: null };
  if (!text) return none;
  const o = await lookupAddress(accountId, { text });
  if (o.kind === "not-exact") return { refused: true };
  if (o.kind !== "exact") return none;
  return { homeAddress: o.place.formattedAddress, homePlaceId: o.place.placeId, homeLat: o.place.lat, homeLng: o.place.lng, homeComponents: o.place.components as unknown as Prisma.InputJsonObject, homeCheckedAt: new Date() };
}
const HOME_REFUSED = { error: NOT_EXACT_MESSAGE, reason: "address-not-exact", field: "homeAddress" };

router.post("/signup", customerSignupLimiter, async (req, res) => {
  const { phone, email, password, name, homeAddress } = req.body ?? {};

  // Block F2: a real US phone, ten digits. Stored as ten digits.
  const phoneDigits = usPhoneDigits(phone);
  if (!phoneDigits) return res.status(400).json(phoneRefusal);
  const emailText = normalizeEmail(email);
  if (!emailText) {
    return res.status(400).json({ error: "email is required and must look like an email address" });
  }
  const problem = passwordProblem(password, phoneDigits, emailText);
  if (problem) {
    return res.status(400).json({ error: problem });
  }
  const home = parseHomeAddress(homeAddress);
  if (home === INVALID) return res.status(400).json({ error: HOME_ADDRESS_ERROR });

  const account = await getDefaultAccount();
  const [phoneTaken, emailTaken] = await Promise.all([
    prisma.customer.findUnique({ where: { accountId_phone: { accountId: account.id, phone: phoneDigits } } }),
    prisma.customer.findUnique({ where: { accountId_email: { accountId: account.id, email: emailText } } }),
  ]);
  if (phoneTaken) {
    return res.status(409).json({ error: "That phone number already has an account. Sign in instead.", field: "phone" });
  }
  if (emailTaken) {
    return res.status(409).json({ error: "That email already has an account. Sign in instead.", field: "email" });
  }

  const homeCols = await homeColumns(account.id, home);
  if ("refused" in homeCols) return res.status(400).json(HOME_REFUSED);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let customer: Customer;
  try {
    customer = await prisma.customer.create({
      data: { accountId: account.id, phone: phoneDigits, email: emailText, passwordHash, name: typeof name === "string" ? safeInline(name, MAX_NAME_LENGTH) || null : null, ...homeCols },
    });
  } catch (err) {
    // Two sign-ups racing past the checks above; the unique indexes decide.
    if ((err as { code?: unknown }).code === "P2002") {
      return res.status(409).json({ error: "That phone number or email already has an account. Sign in instead." });
    }
    throw err;
  }

  await startCustomerSession(res, customer.id);
  res.status(201).json({ customer: publicCustomer(customer) });
});

router.post("/login", customerLoginLimiter, async (req, res) => {
  const { identifier, password } = req.body ?? {};
  if (typeof identifier !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "identifier (phone or email) and password are required" });
  }

  const account = await getDefaultAccount();
  const emailText = normalizeEmail(identifier);
  // New accounts store ten digits; older ones stored every digit typed.
  const phoneDigits = emailText ? null : (usPhoneDigits(identifier) ?? normalizePhone(identifier));
  const customer = emailText
    ? await prisma.customer.findUnique({ where: { accountId_email: { accountId: account.id, email: emailText } } })
    : phoneDigits
      ? await prisma.customer.findUnique({ where: { accountId_phone: { accountId: account.id, phone: phoneDigits } } })
      : null;

  // Always run the compare so timing looks the same whether or not the
  // identifier exists. The failure count lives in the database (five in 15
  // minutes per address, see server/loginLimit.ts), so a deploy does not
  // reset it; the in-memory limiter in front is only a cheap burst cap.
  const result = await attemptLogin("customer", req.ip, async () => (await bcrypt.compare(password, customer?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid")) && customer !== null);
  if (result === "locked") return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
  if (result === "failed" || !customer) {
    return res.status(401).json({ error: BAD_LOGIN });
  }

  await startCustomerSession(res, customer.id);
  res.json({ customer: publicCustomer(customer) });
});

// Deletes the session row behind this cookie, so a copy of the cookie
// stops working too, then clears the cookie.
router.post("/logout", async (req, res) => {
  await endCustomerSession(req, res);
  res.json({ ok: true });
});

// Block A5: the signed-in customer changes their name, phone or home
// address. Email changes are not offered. A phone another account holds
// is refused the way sign-up refuses it.
router.patch("/me", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { name?: string | null; phone?: string } & Partial<HomeColumns> = {};
  if ("name" in body) {
    if (body.name !== null && typeof body.name !== "string") return res.status(400).json({ error: `name must be text up to ${MAX_NAME_LENGTH} characters, or blank` });
    const text = normalizeText(body.name);
    if (text !== null && text.length > MAX_NAME_LENGTH) return res.status(400).json({ error: `name must be text up to ${MAX_NAME_LENGTH} characters, or blank` });
    data.name = text === null ? null : safeInline(text, MAX_NAME_LENGTH) || null;
  }
  if ("phone" in body) {
    const digits = usPhoneDigits(body.phone);
    if (!digits) return res.status(400).json(phoneRefusal);
    if (digits !== customer.phone) {
      const taken = await prisma.customer.findUnique({ where: { accountId_phone: { accountId: customer.accountId, phone: digits } }, select: { id: true } });
      if (taken) return res.status(409).json({ error: "That phone number already has an account.", field: "phone" });
      data.phone = digits;
    }
  }
  if ("homeAddress" in body) {
    const home = parseHomeAddress(body.homeAddress);
    if (home === INVALID) return res.status(400).json({ error: HOME_ADDRESS_ERROR });
    const cols = await homeColumns(customer.accountId, home);
    if ("refused" in cols) return res.status(400).json(HOME_REFUSED);
    Object.assign(data, cols);
  }
  if ("email" in body) return res.status(400).json({ error: "Email changes are not available here. Call or text GO to change your email." });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "Send a name, phone or homeAddress to change" });
  try {
    const updated = await prisma.customer.update({ where: { id: customer.id }, data });
    res.json({ customer: publicCustomer(updated) });
  } catch (err) {
    if ((err as { code?: unknown }).code === "P2002") return res.status(409).json({ error: "That phone number already has an account.", field: "phone" });
    throw err;
  }
});

router.get("/me", requireCustomer, (_req, res) => {
  res.json({ customer: publicCustomer(res.locals.customer as Customer) });
});

// Block F2: the signed-in customer's orders that went to staff review, so
// they can see where each one stands. Built field by field: staff notes and
// the reason for a dismissal never leave the server.
const REQUEST_STATUS: Record<string, { status: string; label: string }> = {
  received: { status: "received", label: "Received" },
  reviewing: { status: "being-reviewed", label: "Being reviewed" },
  Converted: { status: "booked", label: "Turned into a booking" },
  Dismissed: { status: "closed", label: "Closed" },
};
router.get("/requests", requireCustomer, async (_req, res) => {
  const customer = res.locals.customer as Customer;
  const [settings, rows] = await Promise.all([
    getSettings(customer.accountId),
    prisma.designRequest.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const days = settings.requestResponseDays;
  const promise = `We will contact you within ${days} business ${days === 1 ? "day" : "days"}.`;
  res.json({
    responseDays: days,
    promise,
    requests: rows.map((r) => {
      const cart = (r.cart ?? {}) as { items?: { name: string; quantity: number }[]; addons?: { itemName: string; groupName: string; addonName: string }[]; package?: { name: string } | null };
      const open = r.status === "Open";
      const state = open ? (r.notes && r.notes.trim() !== "" ? REQUEST_STATUS.reviewing : REQUEST_STATUS.received) : (REQUEST_STATUS[r.status] ?? REQUEST_STATUS.received);
      return {
        id: r.id,
        status: state.status,
        statusLabel: state.label,
        bookingId: r.status === "Converted" ? r.bookingId : null,
        createdAt: r.createdAt.toISOString(),
        eventDate: r.eventDate.toISOString().slice(0, 10),
        eventTime: r.eventTime,
        occasion: r.occasion,
        address: r.address,
        mapsUrl: bookingMapsUrl(r),
        setupNotes: r.setupNotes,
        guestCount: r.guestCount,
        total: r.total === null ? null : Number(r.total),
        package: cart.package?.name ?? null,
        items: (cart.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity })),
        addons: (cart.addons ?? []).map((a) => ({ itemName: a.itemName, groupName: a.groupName, addonName: a.addonName })),
        // Only an open request still carries the promise.
        promise: open ? promise : null,
      };
    }),
  });
});

router.get("/bookings", requireCustomer, async (_req, res) => {
  const customer = res.locals.customer as Customer;
  const bookings = await prisma.booking.findMany({
    where: { customerId: customer.id },
    include: WITH_UNIT_DETAILS,
    orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }],
  });
  const settings = bookings.length > 0 ? await portalSettings(bookings[0].accountId) : null;
  res.json(bookings.map((b) => ({ ...serializeCustomerBooking(b), ...(settings ? portalFields(b, settings) : {}) })));
});

// A booking is only reachable through the customer that owns it. Anyone
// else's id, or a made-up one, is a 404, not a 403, so the endpoint
// doesn't confirm that a booking exists.
async function ownBooking(customer: Customer, id: string) {
  return prisma.booking.findFirst({ where: { id, customerId: customer.id }, include: WITH_UNIT_DETAILS });
}

function notChangeable(status: string): string | null {
  if (status === "Cancelled") return "This booking was cancelled.";
  if (status === "Released") return "This hold was released because it wasn't confirmed in time. Please book again, or call or text us.";
  if (status === "Completed") return "This booking already happened.";
  return null;
}

// Block F1. A customer cannot cancel a booking themselves any more. This
// call asks GO to cancel it: a cancellation request with their reason. The
// booking, its date and its items stay held until staff decide. When a
// retainer has been paid the retainer terms come back and must be accepted
// (acceptTerms: true) before the request is made.
const termsJson = (t: RetainerTerms | null) => (t ? { source: t.source, title: t.title, text: t.text } : null);

// What the store shows before asking: what was paid, the terms, and a request
// that is already waiting.
router.get("/bookings/:id/cancel", requireCustomer, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const booking = await ownBooking(customer, String(req.params.id));
  if (!booking) return res.status(404).json({ error: "booking not found" });
  const why = notChangeable(booking.status);
  if (why) return res.status(409).json({ error: why });
  const preview = await cancellationPreview(booking.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    paid: preview.money.paidCents / 100,
    retainerPaid: preview.money.retainerPaid,
    termsRequired: preview.termsRequired,
    terms: termsJson(preview.terms),
    pendingRequest: preview.open ? { id: preview.open.id, status: "open", requestedAt: preview.open.createdAt.toISOString(), reason: preview.open.reason } : null,
  });
});

router.post("/bookings/:id/cancel", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const booking = await ownBooking(customer, String(req.params.id));
  if (!booking) {
    return res.status(404).json({ error: "booking not found" });
  }
  if (booking.status === "Cancelled" || booking.status === "Released") {
    return res.json(await portalBooking(booking));
  }
  if (booking.status === "Completed") {
    return res.status(409).json({ error: "This booking already happened." });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== "string" || body.reason.length > MAX_REASON)) {
    return res.status(400).json({ error: `reason must be text up to ${MAX_REASON} characters`, reason: "reason-invalid", field: "reason" });
  }
  const asked = await requestCancellation(booking.id, { reason: typeof body.reason === "string" ? body.reason : null, acceptTerms: body.acceptTerms === true, customerId: customer.id });
  if (!asked.ok) {
    return res.status(409).json({
      error: "A retainer has been paid on this booking. Read and accept the retainer terms to ask to cancel, or call or text GO.",
      reason: "terms-required",
      paid: asked.paidCents / 100,
      terms: termsJson(asked.terms),
    });
  }
  // The booking as it stands (unchanged, with pendingRequest set), plus the
  // request and the terms that were accepted.
  res.status(asked.created ? 202 : 200).json({
    ...(await portalBooking((await ownBooking(customer, booking.id)) as PortalRow)),
    cancellationRequested: true,
    cancellationRequest: { id: asked.request.id, status: "open", requestedAt: asked.request.createdAt.toISOString(), reason: asked.request.reason, termsAccepted: asked.request.termsAcceptedAt !== null },
    paid: asked.paidCents / 100,
    terms: termsJson(asked.terms),
    message: "We got your request to cancel. Your booking is still in place until our team reviews it, and we will email you with the outcome.",
  });
});

router.post("/bookings/:id/reschedule", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const { eventDate, eventTime } = req.body ?? {};

  const change: { date?: Date; time?: string | null } = {};
  if (eventDate !== undefined) {
    const date = normalizeDate(eventDate);
    if (date === null || date === INVALID) {
      return res.status(400).json({ error: "eventDate must be a valid YYYY-MM-DD date" });
    }
    if (date.toISOString().slice(0, 10) < todayEastern()) {
      return res.status(400).json({ error: "eventDate can't be in the past" });
    }
    change.date = date;
  }
  if (eventTime !== undefined) {
    if (eventTime !== null && typeof eventTime !== "string") {
      return res.status(400).json({ error: "eventTime must be text or null" });
    }
    const time = eventTime === null ? null : normalizeText(eventTime);
    if (time && time.length > MAX_TIME_LENGTH) {
      return res.status(400).json({ error: `eventTime must be text up to ${MAX_TIME_LENGTH} characters` });
    }
    change.time = time;
  }
  if (change.date === undefined && change.time === undefined) {
    return res.status(400).json({ error: "eventDate or eventTime is required" });
  }

  const booking = await ownBooking(customer, String(req.params.id));
  if (!booking) {
    return res.status(404).json({ error: "booking not found" });
  }
  const blocked = notChangeable(booking.status);
  if (blocked) {
    return res.status(409).json({ error: blocked });
  }
  if (!selfServeAllowed(booking)) return res.status(409).json({ error: SELF_SERVE_REFUSAL, reason: "call-go" });

  try {
    await rescheduleBooking(booking.id, change, (b) => {
      const when = b.eventTime ? `${b.eventDate.toISOString().slice(0, 10)} at ${b.eventTime}` : b.eventDate.toISOString().slice(0, 10);
      return `Rescheduled to ${when} by the customer from their account.`;
    });
    res.json(await portalBooking((await ownBooking(customer, booking.id)) as PortalRow));
    queueGoogleSync(booking.id);
  } catch (err) {
    if (err instanceof NoFreeUnit || err instanceof NoCrewFree || (err as { code?: unknown }).code === "P2002") {
      const itemName = err instanceof NoFreeUnit || err instanceof NoCrewFree ? err.itemName : "that item";
      return res.status(409).json({
        error: `That date isn't available for ${itemName}. Your booking hasn't changed. Try another date.`,
        reason: "unavailable",
      });
    }
    throw err;
  }
});

router.post("/bookings/:id/change-item", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const { itemId } = req.body ?? {};

  const booking = await ownBooking(customer, String(req.params.id));
  if (!booking) {
    return res.status(404).json({ error: "booking not found" });
  }
  const blocked = notChangeable(booking.status);
  if (blocked) {
    return res.status(409).json({ error: blocked });
  }
  if (!selfServeAllowed(booking)) return res.status(409).json({ error: SELF_SERVE_REFUSAL, reason: "call-go" });

  const item = typeof itemId === "string" ? await prisma.item.findFirst({ where: { id: itemId, accountId: booking.accountId } }) : null;
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }
  // An item is promisable through its units, through the crew for its
  // skills, or both; one with neither can't be.
  const unitCount = await prisma.unit.count({ where: { itemId: item.id } });
  if (item.skills.length === 0 && unitCount === 0) {
    return res.status(409).json({ error: "That item isn't available for direct booking yet.", reason: "not-tracked" });
  }

  try {
    const { unit } = await changeBookingItem(
      booking.id,
      { id: item.id, name: item.name, skills: item.skills, unitCount },
      (b, unitLabel) => `Changed to ${item.name} (${unitLabel}) for ${b.eventDate.toISOString().slice(0, 10)} by the customer from their account.`,
    );
    res.json({ ...(await portalBooking((await ownBooking(customer, booking.id)) as PortalRow)), unit: { id: unit.id, label: unit.label } });
  } catch (err) {
    if (err instanceof NoFreeUnit || err instanceof NoCrewFree || (err as { code?: unknown }).code === "P2002") {
      return res.status(409).json({
        error: `${item.name} isn't available on that date. Your booking hasn't changed.`,
        reason: "unavailable",
      });
    }
    throw err;
  }
});

// ---- Block T1: the customer's own contract and payments ----------------------

// The contract on one of the customer's bookings, in the same shape as the
// public signing link's. 404 for someone else's booking or a booking with no
// contract (a tier 1 rental has none).
router.get("/bookings/:id/contract", requireCustomer, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.id), customerId: customer.id }, select: { id: true, tier: true, agreement: { include: { contractDocument: true } } } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  let agreement = booking.agreement;
  if (!agreement || (!agreement.contractDocument && agreement.format !== "go-v2" && !agreement.signingToken)) {
    if (booking.tier !== 2 && booking.tier !== 3) return res.status(404).json({ error: "There is no contract on this booking." });
    try {
      await prepareContract({ bookingId: booking.id });
    } catch (err) {
      if (err instanceof ContractError) return res.status(404).json({ error: "There is no contract on this booking." });
      throw err;
    }
    agreement = await prisma.agreement.findUnique({ where: { bookingId: booking.id }, include: { contractDocument: true } });
    if (!agreement) return res.status(404).json({ error: "There is no contract on this booking." });
  }
  try {
    const view = await contractView(agreement, req);
    res.status(view.status).json(view.body);
  } catch (err) {
    if (err instanceof ContractError) return res.status(err.status).json({ error: err.message, reason: err.reason });
    throw err;
  }
});

// Signing from the portal: the same rules and the same record as the public
// link, on the customer's own booking only.
router.post("/bookings/:id/sign", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.id), customerId: customer.id }, select: { id: true, agreement: { select: { signingToken: true, format: true, contractStatus: true } } } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  if (!booking.agreement?.signingToken) return res.status(404).json({ error: "There is no contract on this booking." });
  if (booking.agreement.contractStatus === "Signed") return res.status(409).json({ error: "This contract was already signed. Nothing more is needed from you.", reason: "already-signed" });
  const parsed = parseSignBody((req.body ?? {}) as Record<string, unknown>, booking.agreement.format === "go-v2");
  if ("status" in parsed) return res.status(parsed.status).json(parsed.body);
  try {
    const signed = await signContract(booking.agreement.signingToken, {
      fullName: parsed.fullName,
      additionalSignerName: parsed.additionalSignerName,
      consentToElectronicSignature: true,
      agreeToTerms: true,
      contentHash: parsed.contentHash,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      baseRequest: req,
    });
    void notifyContractSigned({ bookingId: booking.id, designRequestId: null }, signed).then(() => sendPayLink(booking.id, "signed"));
    queueGoogleSync(booking.id);
    res.status(201).json({
      signed: true,
      signedAt: signed.signedAt.toISOString(),
      signedName: parsed.fullName,
      documentId: signed.documentId,
      pdfUrl: signed.pdfUrl,
      ...("format" in signed && signed.format === "go-v2" ? { format: "go-v2", document: signed.document } : {}),
    });
  } catch (err) {
    if (err instanceof ContractError) return res.status(err.status).json({ error: err.message, reason: err.reason });
    throw err;
  }
});

// A Checkout Session for the retainer or the balance on the customer's own
// booking. The amount is the admin's; 409 nothing-due or not-payable.
router.post("/bookings/:id/payments/session", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const kind = (req.body ?? {}).kind;
  if (kind !== "retainer" && kind !== "balance") return res.status(400).json({ error: "kind must be retainer or balance" });
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.id), customerId: customer.id }, select: { id: true } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  try {
    const offer = await createPaymentSession(booking.id, kind);
    if (!offer) return res.status(409).json({ error: "Online payment is not set up yet. GO will follow up to collect it.", reason: "not-payable" });
    res.json({ clientSecret: offer.clientSecret, sessionId: offer.sessionId, amount: offer.amount, kind: offer.kind });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message, reason: err.reason });
    if (err instanceof StripeError) return res.status(502).json({ error: "The payment could not be started. Try again in a moment.", reason: "stripe" });
    throw err;
  }
});

// Block A11: this customer's own wedding details.
router.use("/bookings/:id/wedding-details", customerWeddingRouter);

export default router;
