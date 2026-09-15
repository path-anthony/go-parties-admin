import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { leadStatusForStorefrontBooking, lockFreeUnit } from "../availability.js";
import { prisma } from "../db.js";
import { INVALID, normalizeDate, normalizeText } from "../validate.js";

// Thrown inside the transaction when no unit can be locked, so the whole
// thing rolls back and the caller gets a specific answer, not a 500.
class NoFreeUnit extends Error {}

const router = Router();

// Public, no session, rate limited where it's mounted. A customer books one
// specific item for one date. The unit is picked and locked inside the same
// transaction that writes the Booking, its BookingUnit, and the CRM Lead,
// so two requests racing for the last unit can't both succeed.
router.post("/", async (req, res) => {
  const { itemId, eventDate, customerName, contact } = req.body ?? {};

  const name = normalizeText(customerName);
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const contactText = normalizeText(contact);
  if (!contactText) {
    return res.status(400).json({ error: "contact is required" });
  }
  const date = normalizeDate(eventDate);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  }
  const dateText = date.toISOString().slice(0, 10);
  if (dateText < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "eventDate can't be in the past" });
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      const unit = await lockFreeUnit(tx, item.id, dateText);
      if (!unit) throw new NoFreeUnit();

      const lead = await tx.lead.create({
        data: {
          accountId: account.id,
          source: "storefront",
          status: leadStatus,
          customerName: name,
          contact: contactText,
          occasion: item.name,
          dateOfInterest: date,
          notes: `Direct booking of ${item.name} (${unit.label}) from the storefront.`,
        },
      });
      await tx.leadActivity.create({
        data: { leadId: lead.id, text: `Booked ${item.name} (${unit.label}) for ${dateText} from the storefront.` },
      });
      const booking = await tx.booking.create({
        data: {
          accountId: account.id,
          leadId: lead.id,
          eventDate: date,
          customerName: name,
          customerContact: contactText,
          status: "Confirmed",
          units: { create: [{ unitId: unit.id }] },
        },
      });
      return { booking, lead, unit };
    });

    res.status(201).json({
      bookingId: result.booking.id,
      leadId: result.lead.id,
      eventDate: dateText,
      status: result.booking.status,
      depositPaid: result.booking.depositPaid,
      item: { id: item.id, name: item.name },
      unit: { id: result.unit.id, label: result.unit.label },
    });
  } catch (err) {
    if (err instanceof NoFreeUnit) {
      return res.status(409).json({
        error: "That date was just booked by someone else. Try another date.",
        reason: "unavailable",
      });
    }
    throw err;
  }
});

export default router;
