import { AddonSelectionError, describeAddon, resolveAddons, type ChosenAddon } from "./addons.js";
import { leadStatusForStorefrontBooking, lockFreeUnit } from "./availability.js";
import { NoFreeUnits } from "./bookingOps.js";
import { prisma } from "./db.js";
import { NoCrewFree, createGigs, needsCrew } from "./gigs.js";
import { displayStatus, legacyCustomerStatus } from "../src/lib/bookingStatus.js";
import { rushFor } from "./settings.js";
import { getDefaultAccount } from "./account.js";

export const MAX_UNITS_PER_BOOKING = 50;

const out = (status: number, body: unknown) => ({ status, body });

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
};

// The one place a booking is made on a customer's behalf or their own:
// one free unit per item wanted is picked and locked (SKIP LOCKED) in the
// same transaction that writes the Booking, its BookingUnits, its add-ons,
// its gigs and the CRM Lead, so either every item is held or nothing is,
// and two requests racing for the last unit or the last person can't both
// win. The storefront's direct booking and the admin's New booking both
// call this.
export async function createDirectBooking(input: DirectBookingInput): Promise<{ status: number; body: unknown }> {
  const { staff, name, contact, customer, itemIds, quantities = {}, date, dateText, eventTime, address, selections, packageId, totalOverride } = input;
  const account = await getDefaultAccount();
  // Read-only lookups that don't depend on each other run together. None of
  // them takes a lock or feeds the transaction below, so this changes how
  // long the request waits, not what it guarantees. The rush flag and the
  // lead column are worked out here too rather than inside the transaction,
  // so row locks aren't held while they are read.
  const [pkg, found, leadStatus, rush] = await Promise.all([
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
  // Keep the caller's order so the response lines up with the request.
  const items = itemIds.map((id) => found.find((item) => item.id === id)).filter((item) => item !== undefined);
  if (items.length !== itemIds.length) {
    return out(404, { error: itemIds.length === 1 ? "item not found" : "One or more items were not found" });
  }
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
  const baseTotal = quotedTotal(pkg, wanted);
  const computedTotal = baseTotal === null ? null : Math.round((baseTotal + addonsTotal) * 100) / 100;
  // Staff can confirm a different price on the phone; nobody else can.
  const total = totalOverride === undefined ? computedTotal : totalOverride;
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
      const lead = await tx.lead.create({
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
          text: `Booked ${summary} for ${when} ${origin}.${addonNote ? ` Add-ons: ${addonNote}.` : ""}`,
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
          customerName: name,
          phone: contact.phone,
          email: contact.email,
          status: "Held",
          rush,
          packageId: pkg?.id ?? null,
          total,
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
      return { booking, lead, claimed, gigs };
    });

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
      leadId: result.lead.id,
      customerId: result.booking.customerId,
      eventDate: dateText,
      eventTime: result.booking.eventTime,
      address: result.booking.address,
      phone: result.booking.phone,
      email: result.booking.email,
      // status keeps the meaning the storefront reads (live = "Confirmed");
      // stage is the real one, depositPaid the old name for retainerPaid.
      status: legacyCustomerStatus(result.booking.status),
      stage: displayStatus(result.booking),
      // True when the event starts inside the minimum notice window; the
      // booking is complete either way, this is so the storefront can say
      // it is pending confirmation.
      rush: result.booking.rush,
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
      gigs: result.gigs,
    });
  } catch (err) {
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
