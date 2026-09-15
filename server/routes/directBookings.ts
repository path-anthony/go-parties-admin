import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { leadStatusForStorefrontBooking, lockFreeUnit } from "../availability.js";
import { NoFreeUnit } from "../bookingOps.js";
import { currentCustomer } from "../customerAuth.js";
import { prisma } from "../db.js";
import { INVALID, normalizeDate, normalizeText, splitContact } from "../validate.js";

const MAX_ADDRESS_LENGTH = 300;
const MAX_TIME_LENGTH = 60;

const router = Router();

// Contact comes one of two ways. phone and email as separate fields, both
// required, is the contract. A single legacy "contact" is still accepted
// and sorted into phone or email by shape (the other side stays null), so
// a storefront build that still sends one field keeps working until it
// collects both. Sending phone or email means both must be present. A
// signed-in customer can leave all of it out and their account fills it.
function resolveContact(
  body: Record<string, unknown>,
  fallback: { phone: string; email: string } | null,
): { phone: string | null; email: string | null } | string {
  if ("phone" in body || "email" in body) {
    const phone = normalizeText(body.phone);
    const email = normalizeText(body.email);
    if (!phone || !email) return "phone and email are both required";
    return { phone, email };
  }
  const contact = normalizeText(body.contact);
  if (contact) return splitContact(contact);
  if (fallback) return fallback;
  return "phone and email are required";
}

function optionalText(value: unknown, max: number): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const text = value.trim();
  if (text === "") return null;
  return text.length <= max ? text : INVALID;
}

// Public, no session required, rate limited where it's mounted. A customer
// books one specific item for one date. The unit is picked and locked
// inside the same transaction that writes the Booking, its BookingUnit,
// and the CRM Lead, so two requests racing for the last unit can't both
// succeed. If a customer session is present the booking is attached to
// that account and name, phone, and email default from it.
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { itemId, eventDate } = body;

  const customer = await currentCustomer(req);
  const name = normalizeText(body.customerName) ?? customer?.name ?? null;
  if (!name) {
    return res.status(400).json({
      error: customer ? "customerName is required the first time; it's saved to your account after that" : "customerName is required",
    });
  }
  const contact = resolveContact(body, customer ? { phone: customer.phone, email: customer.email } : null);
  if (typeof contact === "string") {
    return res.status(400).json({ error: contact });
  }
  const date = normalizeDate(eventDate);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  }
  const dateText = date.toISOString().slice(0, 10);
  if (dateText < new Date().toISOString().slice(0, 10)) {
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

  const account = await getDefaultAccount();
  const item = typeof itemId === "string" ? await prisma.item.findFirst({ where: { id: itemId, accountId: account.id } }) : null;
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }

  const totalUnits = await prisma.unit.count({ where: { itemId: item.id } });
  if (totalUnits === 0) {
    return res.status(409).json({
      error: "This item isn't available for direct booking yet.",
      reason: "not-tracked",
    });
  }

  const leadStatus = await leadStatusForStorefrontBooking(account.id);
  const leadContact = [contact.phone, contact.email].filter(Boolean).join(" · ");
  const when = eventTime ? `${dateText} at ${eventTime}` : dateText;
  const where = address ? ` Address: ${address}.` : " Address not given yet.";

  try {
    const result = await prisma.$transaction(async (tx) => {
      const unit = await lockFreeUnit(tx, item.id, dateText);
      if (!unit) throw new NoFreeUnit(item.name);

      const lead = await tx.lead.create({
        data: {
          accountId: account.id,
          source: "storefront",
          status: leadStatus,
          customerName: name,
          contact: leadContact,
          occasion: item.name,
          dateOfInterest: date,
          notes: `Direct booking of ${item.name} (${unit.label}) from the storefront, ${when}.${where}`,
        },
      });
      await tx.leadActivity.create({
        data: { leadId: lead.id, text: `Booked ${item.name} (${unit.label}) for ${when} from the storefront.` },
      });
      const booking = await tx.booking.create({
        data: {
          accountId: account.id,
          leadId: lead.id,
          customerId: customer?.id ?? null,
          eventDate: date,
          eventTime,
          address,
          customerName: name,
          phone: contact.phone,
          email: contact.email,
          status: "Confirmed",
          // eventDate is copied onto the join row for the (unitId, eventDate)
          // unique constraint, the database-level backstop behind the lock.
          units: { create: [{ unitId: unit.id, eventDate: date }] },
        },
      });
      // First booking from an account that signed up without a name: keep
      // the name so the next booking doesn't ask again.
      if (customer && !customer.name) {
        await tx.customer.update({ where: { id: customer.id }, data: { name } });
      }
      return { booking, lead, unit };
    });

    res.status(201).json({
      bookingId: result.booking.id,
      leadId: result.lead.id,
      customerId: result.booking.customerId,
      eventDate: dateText,
      eventTime: result.booking.eventTime,
      address: result.booking.address,
      phone: result.booking.phone,
      email: result.booking.email,
      status: result.booking.status,
      depositPaid: result.booking.depositPaid,
      item: { id: item.id, name: item.name },
      unit: { id: result.unit.id, label: result.unit.label },
    });
  } catch (err) {
    // NoFreeUnit is the normal loser path. P2002 is the (unitId, eventDate)
    // unique constraint firing anyway, which the lock should make
    // impossible here; it's handled the same way rather than as a 500.
    if (err instanceof NoFreeUnit || (err as { code?: unknown }).code === "P2002") {
      return res.status(409).json({
        error: "That date was just booked by someone else. Try another date.",
        reason: "unavailable",
      });
    }
    throw err;
  }
});

export default router;
