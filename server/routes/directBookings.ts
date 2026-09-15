import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { leadStatusForStorefrontBooking, lockFreeUnit } from "../availability.js";
import { NoFreeUnits } from "../bookingOps.js";
import { currentCustomer } from "../customerAuth.js";
import { prisma } from "../db.js";
import { INVALID, normalizeDate, normalizeText, splitContact } from "../validate.js";

const MAX_ADDRESS_LENGTH = 300;
const MAX_TIME_LENGTH = 60;
const MAX_ITEMS_PER_BOOKING = 10;

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

// Public, no session required, rate limited where it's mounted. A customer
// books one or more specific items for one date. One free unit per item is
// picked and locked (SKIP LOCKED) inside the same transaction that writes
// the Booking, its BookingUnit rows, and the CRM Lead: either every item
// gets a unit or the whole request rolls back with nothing booked, and two
// requests racing for the last unit of any item can't both succeed. If a
// customer session is present the booking is attached to that account and
// name, phone, and email default from it.
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

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
  const itemIds = resolveItemIds(body);
  if (typeof itemIds === "string") {
    return res.status(400).json({ error: itemIds });
  }
  const date = normalizeDate(body.eventDate);
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
  const found = await prisma.item.findMany({
    where: { id: { in: itemIds }, accountId: account.id },
    include: { _count: { select: { units: true } } },
  });
  // Keep the caller's order so the response lines up with the request.
  const items = itemIds.map((id) => found.find((item) => item.id === id)).filter((item) => item !== undefined);
  if (items.length !== itemIds.length) {
    return res.status(404).json({ error: itemIds.length === 1 ? "item not found" : "One or more items were not found" });
  }
  const untracked = items.filter((item) => item._count.units === 0);
  if (untracked.length > 0) {
    return res.status(409).json({
      error:
        untracked.length === 1
          ? "This item isn't available for direct booking yet."
          : `${untracked.map((item) => item.name).join(", ")} aren't available for direct booking yet.`,
      reason: "not-tracked",
      itemIds: untracked.map((item) => item.id),
    });
  }

  const leadStatus = await leadStatusForStorefrontBooking(account.id);
  const leadContact = [contact.phone, contact.email].filter(Boolean).join(" · ");
  const when = eventTime ? `${dateText} at ${eventTime}` : dateText;
  const where = address ? ` Address: ${address}.` : " Address not given yet.";

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock a unit for every item before writing anything. Every item that
      // has nothing free is collected so the message can name all of them.
      const claimed: { item: (typeof items)[number]; unit: { id: string; label: string } }[] = [];
      const missing: string[] = [];
      for (const item of items) {
        const unit = await lockFreeUnit(tx, item.id, dateText);
        if (unit) claimed.push({ item, unit });
        else missing.push(item.name);
      }
      if (missing.length > 0) throw new NoFreeUnits(missing);

      const summary = claimed.map(({ item, unit }) => `${item.name} (${unit.label})`).join(", ");
      const lead = await tx.lead.create({
        data: {
          accountId: account.id,
          source: "storefront",
          status: leadStatus,
          customerName: name,
          contact: leadContact,
          occasion: claimed.map(({ item }) => item.name).join(", "),
          dateOfInterest: date,
          notes: `Direct booking of ${summary} from the storefront, ${when}.${where}`,
        },
      });
      await tx.leadActivity.create({
        data: { leadId: lead.id, text: `Booked ${summary} for ${when} from the storefront.` },
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
          // eventDate is copied onto each join row for the (unitId, eventDate)
          // unique constraint, the database-level backstop behind the lock.
          units: { create: claimed.map(({ unit }) => ({ unitId: unit.id, eventDate: date })) },
        },
      });
      // First booking from an account that signed up without a name: keep
      // the name so the next booking doesn't ask again.
      if (customer && !customer.name) {
        await tx.customer.update({ where: { id: customer.id }, data: { name } });
      }
      return { booking, lead, claimed };
    });

    const bookedItems = result.claimed.map(({ item, unit }) => ({
      id: item.id,
      name: item.name,
      unit: { id: unit.id, label: unit.label },
    }));
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
      // item and unit are the first entry, kept for single-item callers;
      // items has every one.
      item: { id: bookedItems[0].id, name: bookedItems[0].name },
      unit: bookedItems[0].unit,
      items: bookedItems,
    });
  } catch (err) {
    // NoFreeUnits is the normal loser path. P2002 is the (unitId, eventDate)
    // unique constraint firing anyway, which the lock should make
    // impossible here; it's handled the same way rather than as a 500.
    if (err instanceof NoFreeUnits) {
      const names = err.itemNames;
      return res.status(409).json({
        error:
          items.length === 1
            ? "That date was just booked by someone else. Try another date."
            : `${names.join(", ")} ${names.length === 1 ? "isn't" : "aren't"} available that date, so nothing was booked. Drop ${names.length === 1 ? "it" : "them"} or try another date.`,
        reason: "unavailable",
        unavailable: names,
      });
    }
    if ((err as { code?: unknown }).code === "P2002") {
      return res.status(409).json({
        error: "That date was just booked by someone else. Try another date.",
        reason: "unavailable",
      });
    }
    throw err;
  }
});

export default router;
