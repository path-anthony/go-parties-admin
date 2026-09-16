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
const MAX_UNITS_PER_BOOKING = 50;

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

// The price a direct booking is quoted at: the package's bundle price, or
// each priced item times its quantity. Null when nothing has a price.
function quotedTotal(
  pkg: { price: unknown } | null,
  wanted: { item: { price: unknown }; quantity: number }[],
): number | null {
  if (pkg) return Number(pkg.price);
  const priced = wanted.filter(({ item }) => item.price !== null);
  if (priced.length === 0) return null;
  return Math.round(priced.reduce((sum, { item, quantity }) => sum + Number(item.price) * quantity, 0) * 100) / 100;
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
  const packageId = resolvePackageId(body);
  if (packageId === INVALID) {
    return res.status(400).json({ error: "packageId must be a package id" });
  }

  const account = await getDefaultAccount();
  const pkg = packageId
    ? await prisma.package.findFirst({
        where: { id: packageId, accountId: account.id, status: "Published" },
        include: { items: { select: { itemId: true, quantity: true } } },
      })
    : null;
  if (packageId && !pkg) {
    return res.status(404).json({ error: "package not found or not published" });
  }
  if (pkg) {
    const packageIds = new Set(pkg.items.map((row) => row.itemId));
    const same = packageIds.size === itemIds.length && itemIds.every((id) => packageIds.has(id));
    if (!same) {
      return res.status(400).json({ error: "The items don't match the package. Book the package as it is, or book the items on their own." });
    }
  }
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
  // How many units of each item to hold: the package's quantities, or one.
  const wanted = items.map((item) => ({
    item,
    quantity: pkg ? (pkg.items.find((row) => row.itemId === item.id)?.quantity ?? 1) : 1,
  }));
  if (wanted.reduce((sum, w) => sum + w.quantity, 0) > MAX_UNITS_PER_BOOKING) {
    return res.status(400).json({ error: `A booking can hold at most ${MAX_UNITS_PER_BOOKING} units` });
  }
  const total = quotedTotal(pkg, wanted);

  const leadStatus = await leadStatusForStorefrontBooking(account.id);
  const leadContact = [contact.phone, contact.email].filter(Boolean).join(" · ");
  const when = eventTime ? `${dateText} at ${eventTime}` : dateText;
  const where = address ? ` Address: ${address}.` : " Address not given yet.";

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock every unit before writing anything: the wanted quantity of
      // each item, each lock skipping the units this transaction already
      // holds. An item short by even one unit is collected so the message
      // can name all of them.
      const claimed: { item: (typeof items)[number]; unit: { id: string; label: string } }[] = [];
      const missing: string[] = [];
      for (const { item, quantity } of wanted) {
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

      const summary = claimed.map(({ item, unit }) => `${item.name} (${unit.label})`).join(", ");
      const packageNote = pkg ? ` Package: ${pkg.name}, $${Number(pkg.price)}.` : "";
      const lead = await tx.lead.create({
        data: {
          accountId: account.id,
          source: "storefront",
          status: leadStatus,
          customerName: name,
          contact: leadContact,
          occasion: pkg ? pkg.name : claimed.map(({ item }) => item.name).join(", "),
          dateOfInterest: date,
          notes: `Direct booking of ${summary} from the storefront, ${when}.${where}${packageNote}`,
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
          packageId: pkg?.id ?? null,
          total,
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
      total,
      packageId: pkg?.id ?? null,
      package: pkg ? { id: pkg.id, name: pkg.name, price: Number(pkg.price) } : null,
      // item and unit are the first entry, kept for single-item callers;
      // items has every unit held, so an item wanted twice appears twice.
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
