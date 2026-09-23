import bcrypt from "bcryptjs";
import { Router } from "express";
import type { Customer } from "../../src/generated/prisma/client.js";
import { getDefaultAccount } from "../account.js";
import {
  NoFreeUnit,
  cancelBooking,
  changeBookingItem,
  rescheduleBooking,
  serializeCustomerBooking,
} from "../bookingOps.js";
import {
  endCustomerSession,
  normalizeEmail,
  normalizePhone,
  passwordProblem,
  publicCustomer,
  requireCustomer,
  startCustomerSession,
} from "../customerAuth.js";
import { prisma } from "../db.js";
import { BOOKING_GIGS_SELECT, NoCrewFree } from "../gigs.js";
import { customerActionLimiter, customerLoginLimiter, customerSignupLimiter } from "../rateLimit.js";
import { INVALID, normalizeDate, normalizeText } from "../validate.js";

const BCRYPT_ROUNDS = 12;
const MAX_TIME_LENGTH = 60;
// Same wording for an unknown identifier and a wrong password, so a login
// attempt can't be used to check whether an address has an account.
const BAD_LOGIN = "That phone or email and password don't match.";

const router = Router();

const WITH_UNIT_DETAILS = {
  units: { include: { unit: { include: { item: { select: { id: true, name: true } } } } } },
  addons: { orderBy: { createdAt: "asc" as const } },
  gigs: BOOKING_GIGS_SELECT,
} as const;

router.post("/signup", customerSignupLimiter, async (req, res) => {
  const { phone, email, password, name } = req.body ?? {};

  const phoneDigits = normalizePhone(phone);
  if (!phoneDigits) {
    return res.status(400).json({ error: "phone is required (7 to 15 digits)" });
  }
  const emailText = normalizeEmail(email);
  if (!emailText) {
    return res.status(400).json({ error: "email is required and must look like an email address" });
  }
  const problem = passwordProblem(password, phoneDigits, emailText);
  if (problem) {
    return res.status(400).json({ error: problem });
  }

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

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let customer: Customer;
  try {
    customer = await prisma.customer.create({
      data: { accountId: account.id, phone: phoneDigits, email: emailText, passwordHash, name: normalizeText(name) },
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
  const phoneDigits = emailText ? null : normalizePhone(identifier);
  const customer = emailText
    ? await prisma.customer.findUnique({ where: { accountId_email: { accountId: account.id, email: emailText } } })
    : phoneDigits
      ? await prisma.customer.findUnique({ where: { accountId_phone: { accountId: account.id, phone: phoneDigits } } })
      : null;

  // Always run the compare so timing looks the same whether or not the
  // identifier exists.
  const ok = await bcrypt.compare(password, customer?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
  if (!customer || !ok) {
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

router.get("/me", requireCustomer, (_req, res) => {
  res.json({ customer: publicCustomer(res.locals.customer as Customer) });
});

router.get("/bookings", requireCustomer, async (_req, res) => {
  const customer = res.locals.customer as Customer;
  const bookings = await prisma.booking.findMany({
    where: { customerId: customer.id },
    include: WITH_UNIT_DETAILS,
    orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }],
  });
  res.json(bookings.map(serializeCustomerBooking));
});

// A booking is only reachable through the customer that owns it. Anyone
// else's id, or a made-up one, is a 404, not a 403, so the endpoint
// doesn't confirm that a booking exists.
async function ownBooking(customer: Customer, id: string) {
  return prisma.booking.findFirst({ where: { id, customerId: customer.id }, include: WITH_UNIT_DETAILS });
}

function notChangeable(status: string): string | null {
  if (status === "Cancelled") return "This booking was cancelled.";
  if (status === "Completed") return "This booking already happened.";
  return null;
}

router.post("/bookings/:id/cancel", requireCustomer, customerActionLimiter, async (req, res) => {
  const customer = res.locals.customer as Customer;
  const booking = await ownBooking(customer, String(req.params.id));
  if (!booking) {
    return res.status(404).json({ error: "booking not found" });
  }
  if (booking.status === "Cancelled") {
    return res.json(serializeCustomerBooking(booking));
  }
  if (booking.status === "Completed") {
    return res.status(409).json({ error: "This booking already happened." });
  }

  const cancelled = await cancelBooking(booking.id, "Cancelled by the customer from their account.");
  res.json(serializeCustomerBooking(cancelled));
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
    if (date.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) {
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

  try {
    const updated = await rescheduleBooking(booking.id, change, (b) => {
      const when = b.eventTime ? `${b.eventDate.toISOString().slice(0, 10)} at ${b.eventTime}` : b.eventDate.toISOString().slice(0, 10);
      return `Rescheduled to ${when} by the customer from their account.`;
    });
    res.json(serializeCustomerBooking(updated));
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
    const { booking: updated, unit } = await changeBookingItem(
      booking.id,
      { id: item.id, name: item.name, skills: item.skills, unitCount },
      (b, unitLabel) => `Changed to ${item.name} (${unitLabel}) for ${b.eventDate.toISOString().slice(0, 10)} by the customer from their account.`,
    );
    res.json({ ...serializeCustomerBooking(updated), unit: { id: unit.id, label: unit.label } });
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

export default router;
