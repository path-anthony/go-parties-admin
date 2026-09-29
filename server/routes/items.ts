import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { ADDON_GROUPS_INCLUDE } from "../addons.js";
import { TEMPLATE_HEADERS, importCsv, previewCsv } from "../bulkItems.js";
import { toCsv } from "../csv.js";
import { prisma } from "../db.js";
import { validateSkills } from "../skills.js";
import { ITEM_SOURCES } from "../../src/lib/itemFields.js";
import { normalizeBilledPer } from "../itemFields.js";
import { isOneOf } from "../validate.js";

const CSV_HEADERS = ["name", "category", "price", "price_unit", "notes", "photo_url", "source", "needs_price_review"];

const router = Router();

const EDITABLE_FIELDS = ["name", "category", "price", "priceUnit", "notes", "photoUrl", "skills", "source", "needsPriceReview"] as const;

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizePrice(value: unknown): number | null | typeof INVALID {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? INVALID : num;
}

const INVALID = Symbol("invalid");

// A compressed upload is a few hundred KB; anything near this is not one.
const MAX_PHOTO_URL_LENGTH = 2_000_000;

function photoUrlTooLong(value: unknown): boolean {
  return typeof value === "string" && value.length > MAX_PHOTO_URL_LENGTH;
}

// Everything that would be affected by deleting an item, so the admin can
// be told before it happens and the delete itself can refuse when it must.
//
// - packages: every package (Draft or Published) that lists the item, with
//   how many distinct items it holds, so the caller can see which ones
//   would be left empty.
// - heldByBookings: Confirmed or Completed bookings holding one of this
//   item's units. Deleting the item would cascade through its units and
//   silently strip those bookings of what they hold, so the delete refuses
//   while this is above zero. A live gig for the item counts the same way.
async function describeUsage(itemId: string) {
  const [packages, heldByBookings] = await Promise.all([
    prisma.package.findMany({
      where: { items: { some: { itemId } } },
      select: { id: true, name: true, status: true, _count: { select: { items: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.booking.count({
      where: {
        status: { not: "Cancelled" },
        OR: [{ units: { some: { unit: { itemId } } } }, { gigs: { some: { itemId, status: { not: "Cancelled" } } } }],
      },
    }),
  ]);
  return {
    packages: packages.map((pkg) => ({ id: pkg.id, name: pkg.name, status: pkg.status, itemCount: pkg._count.items })),
    heldByBookings,
  };
}

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({
    where: { accountId: account.id },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: ADDON_GROUPS_INCLUDE,
  });
  res.json(items);
});

router.get("/export.csv", async (_req, res) => {
  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({
    where: { accountId: account.id },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  // Uploaded photos live in photoUrl as data URLs of a few hundred KB each;
  // dumping those into a spreadsheet would make it unusable, and the
  // template format expects a link, so they're marked instead.
  const rows = items.map((item) => [
    item.name,
    item.category,
    item.price?.toString() ?? "",
    item.priceUnit ?? "",
    item.notes ?? "",
    item.photoUrl?.startsWith("data:") ? "(uploaded photo)" : (item.photoUrl ?? ""),
    item.source,
    item.needsPriceReview ? "yes" : "",
  ]);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="items-export.csv"');
  res.send(toCsv(CSV_HEADERS, rows));
});

const MAX_STARTING_UNITS = 50;

// Creates an item and, in the same transaction, its starting units.
// skills: any number from the fixed list, default none. startingUnits:
// how many unit rows to create, default 1; forced to 0 when the item has
// skills, since a service item is covered by crew and a unit on it would
// cap it at one booking a day. Units are labelled "Unit #1", "Unit #2",
// the same default the bulk action and the catalog-wide default used.
// The empty template for a bulk add: the exact headers the importer
// reads, nothing else, so a filled-in copy imports as is.
router.get("/bulk/template.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="items-bulk-template.csv"');
  res.send(toCsv([...TEMPLATE_HEADERS], []));
});

const MAX_CSV_LENGTH = 2_000_000;

function readCsvBody(body: unknown): string | null {
  const csv = (body as { csv?: unknown } | null)?.csv;
  return typeof csv === "string" && csv.trim() !== "" && csv.length <= MAX_CSV_LENGTH ? csv : null;
}

// What a file would create, row by row, with every problem named.
// Nothing is written.
router.post("/bulk/preview", async (req, res) => {
  const csv = readCsvBody(req.body);
  if (!csv) return res.status(400).json({ error: "csv is required: the file's text, up to 2 MB" });
  const account = await getDefaultAccount();
  res.json(await previewCsv(csv, account.id));
});

// Creates every row without problems, in one transaction, and reports
// what was created and what was skipped and why.
router.post("/bulk", async (req, res) => {
  const csv = readCsvBody(req.body);
  if (!csv) return res.status(400).json({ error: "csv is required: the file's text, up to 2 MB" });
  const account = await getDefaultAccount();
  res.status(201).json(await importCsv(csv, account.id));
});

router.post("/", async (req, res) => {
  const { name, category, price, priceUnit, notes, photoUrl, skills, startingUnits, source, needsPriceReview } = req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required" });
  }
  if (typeof category !== "string" || category.trim() === "") {
    return res.status(400).json({ error: "category is required" });
  }
  const normalizedPrice = normalizePrice(price);
  if (normalizedPrice === INVALID) {
    return res.status(400).json({ error: "price must be a number" });
  }
  if (photoUrlTooLong(photoUrl)) {
    return res.status(400).json({ error: "photoUrl is too large" });
  }
  const billedPer = normalizeBilledPer(priceUnit);
  if ("error" in billedPer) {
    return res.status(400).json({ error: billedPer.error });
  }
  if (source !== undefined && !isOneOf(ITEM_SOURCES, source)) {
    return res.status(400).json({ error: `source must be one of ${ITEM_SOURCES.join(", ")}` });
  }
  if (needsPriceReview !== undefined && typeof needsPriceReview !== "boolean") {
    return res.status(400).json({ error: "needsPriceReview must be true or false" });
  }
  const account = await getDefaultAccount();
  const skillList = skills === undefined ? [] : await validateSkills(account.id, skills);
  if (typeof skillList === "string") {
    return res.status(400).json({ error: skillList });
  }
  let unitCount = 1;
  if (startingUnits !== undefined) {
    if (!Number.isInteger(startingUnits) || startingUnits < 0 || startingUnits > MAX_STARTING_UNITS) {
      return res.status(400).json({ error: `startingUnits must be a whole number from 0 to ${MAX_STARTING_UNITS}` });
    }
    unitCount = startingUnits;
  }
  if (skillList.length > 0) unitCount = 0;

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        accountId: account.id,
        name: name.trim(),
        category: category.trim(),
        price: normalizedPrice,
        priceUnit: billedPer.value,
        ...(source !== undefined ? { source } : {}),
        ...(needsPriceReview !== undefined ? { needsPriceReview } : {}),
        notes: normalizeText(notes),
        photoUrl: normalizeText(photoUrl),
        skills: skillList,
      },
    });
    if (unitCount > 0) {
      await tx.unit.createMany({
        data: Array.from({ length: unitCount }, (_, n) => ({ itemId: created.id, label: `Unit #${n + 1}`, status: "Available" })),
      });
    }
    return tx.item.findUniqueOrThrow({ where: { id: created.id }, include: { ...ADDON_GROUPS_INCLUDE, _count: { select: { units: true } } } });
  });

  const { _count, ...rest } = item;
  res.status(201).json({ ...rest, unitCount: _count.units });
});

router.patch("/:id", async (req, res) => {
  const id = String(req.params.id);
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.item.findFirst({ where: { id, accountId: account.id } });
  if (!existing) {
    return res.status(404).json({ error: "item not found" });
  }

  if (photoUrlTooLong(body.photoUrl)) {
    return res.status(400).json({ error: "photoUrl is too large" });
  }

  const data: Record<string, string | number | boolean | string[] | null> = {};

  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;

    if (field === "price") {
      const normalizedPrice = normalizePrice(body.price);
      if (normalizedPrice === INVALID) {
        return res.status(400).json({ error: "price must be a number" });
      }
      data.price = normalizedPrice;
      continue;
    }

    if (field === "name" || field === "category") {
      const text = typeof body[field] === "string" ? body[field].trim() : "";
      if (text === "") {
        return res.status(400).json({ error: `${field} is required` });
      }
      data[field] = text;
      continue;
    }

    // The crew skills the item needs, any number from the fixed list,
    // independent of whether it has units.
    if (field === "skills") {
      const skills = await validateSkills(account.id, body.skills);
      if (typeof skills === "string") {
        return res.status(400).json({ error: skills });
      }
      data.skills = skills;
      continue;
    }

    if (field === "priceUnit") {
      const billedPer = normalizeBilledPer(body.priceUnit);
      if ("error" in billedPer) {
        return res.status(400).json({ error: billedPer.error });
      }
      data.priceUnit = billedPer.value;
      continue;
    }

    if (field === "source") {
      if (!isOneOf(ITEM_SOURCES, body.source)) {
        return res.status(400).json({ error: `source must be one of ${ITEM_SOURCES.join(", ")}` });
      }
      data.source = body.source;
      continue;
    }

    if (field === "needsPriceReview") {
      if (typeof body.needsPriceReview !== "boolean") {
        return res.status(400).json({ error: "needsPriceReview must be true or false" });
      }
      data.needsPriceReview = body.needsPriceReview;
      continue;
    }

    data[field as "notes" | "photoUrl"] = normalizeText(body[field]);
  }

  const item = await prisma.item.update({ where: { id }, data, include: ADDON_GROUPS_INCLUDE });
  res.json(item);
});

// What deleting this item would touch, for the confirmation step. Read
// only; nothing changes here.
router.get("/:id/usage", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const item = await prisma.item.findFirst({ where: { id, accountId: account.id }, select: { id: true } });
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }
  res.json(await describeUsage(id));
});

// A real delete. The database cascades the item's units, add-on groups and
// package rows, and that cascade is exactly what has to be handled with
// care:
//
// - If any Confirmed or Completed booking holds one of the item's units,
//   the delete is refused (409): cascading would silently release those
//   units and leave real bookings holding nothing.
// - Every package that listed the item loses it. A Published package that
//   is left with no items at all is set back to Draft in the same
//   transaction, so nothing empty stays on the storefront. Packages that
//   still have other items stay as they are, Published or not.
// - Bookings that chose one of this item's add-ons keep their copy of the
//   names and price (BookingAddon.itemId becomes null), so the record of
//   what was sold is untouched.
//
// The response says what happened so the admin can be told plainly.
router.delete("/:id", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const item = await prisma.item.findFirst({ where: { id, accountId: account.id }, select: { id: true, name: true } });
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }

  const usage = await describeUsage(id);
  if (usage.heldByBookings > 0) {
    return res.status(409).json({
      error:
        `${item.name} is on ${usage.heldByBookings} ${usage.heldByBookings === 1 ? "booking that isn't" : "bookings that aren't"} ` +
        "cancelled. Remove it from those bookings first, or cancel them, then delete the item.",
      reason: "in-use",
      heldByBookings: usage.heldByBookings,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.item.delete({ where: { id } });

    // The cascade has already removed this item's package rows. Any
    // affected package that was Published and now holds nothing comes off
    // the storefront. Counted after the delete, inside the transaction, so
    // it reflects exactly what the cascade left behind.
    const unpublished: { id: string; name: string }[] = [];
    for (const pkg of usage.packages) {
      if (pkg.status !== "Published") continue;
      const remaining = await tx.packageItem.count({ where: { packageId: pkg.id } });
      if (remaining === 0) {
        await tx.package.update({ where: { id: pkg.id }, data: { status: "Draft" } });
        unpublished.push({ id: pkg.id, name: pkg.name });
      }
    }
    return { unpublished };
  });

  res.json({
    ok: true,
    removedFrom: usage.packages.map((pkg) => ({ id: pkg.id, name: pkg.name })),
    unpublished: result.unpublished,
  });
});

// ---------------------------------------------------------------------
// Delete several items at once. The same rules as the single delete,
// applied to the whole selection:
//
// - One usage report for everything selected: every package (Draft or
//   Published) that lists any of them, how many of its items are in the
//   selection, and which Published packages would be left with nothing
//   and so be taken off the storefront.
// - Any selected item held by a Confirmed or Completed booking (or a live
//   gig on one) blocks the whole delete. It is refused by name, never
//   skipped: nothing is deleted until the selection is clean, so the
//   admin decides what to do about the blocked ones.
// - The check runs again inside the delete's transaction, after the
//   units are locked, so a booking that lands between the confirmation
//   and the click can't be stripped of what it holds.

const MAX_BULK_DELETE = 500;

function readItemIds(body: unknown): string[] | string {
  const ids = (body as { itemIds?: unknown } | null)?.itemIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string")) {
    return "itemIds must be a non-empty list of item ids";
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_DELETE) return `itemIds can hold at most ${MAX_BULK_DELETE} items`;
  return unique;
}

type Db = Pick<typeof prisma, "item" | "booking" | "package">;

// Per selected item, how many bookings that aren't cancelled hold it (a
// unit of it, or a live gig for it).
async function heldCounts(db: Db, itemIds: string[]): Promise<Map<string, number>> {
  const bookings = await db.booking.findMany({
    where: {
      status: { not: "Cancelled" },
      OR: [{ units: { some: { unit: { itemId: { in: itemIds } } } } }, { gigs: { some: { itemId: { in: itemIds }, status: { not: "Cancelled" } } } }],
    },
    select: {
      id: true,
      units: { where: { unit: { itemId: { in: itemIds } } }, select: { unit: { select: { itemId: true } } } },
      gigs: { where: { itemId: { in: itemIds }, status: { not: "Cancelled" } }, select: { itemId: true } },
    },
  });
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    const held = new Set<string>();
    for (const row of booking.units) held.add(row.unit.itemId);
    for (const gig of booking.gigs) if (gig.itemId) held.add(gig.itemId);
    for (const itemId of held) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
  }
  return counts;
}

async function describeBulkUsage(db: Db, accountId: string, itemIds: string[]) {
  const [items, packages, held] = await Promise.all([
    db.item.findMany({ where: { id: { in: itemIds }, accountId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.package.findMany({
      where: { accountId, items: { some: { itemId: { in: itemIds } } } },
      select: { id: true, name: true, status: true, items: { select: { itemId: true } } },
      orderBy: { name: "asc" },
    }),
    heldCounts(db, itemIds),
  ]);
  const selected = new Set(itemIds);
  return {
    items,
    blocked: items.filter((item) => (held.get(item.id) ?? 0) > 0).map((item) => ({ id: item.id, name: item.name, heldByBookings: held.get(item.id) ?? 0 })),
    packages: packages.map((pkg) => {
      const itemCount = pkg.items.length;
      const selectedCount = pkg.items.filter((row) => selected.has(row.itemId)).length;
      return {
        id: pkg.id,
        name: pkg.name,
        status: pkg.status,
        itemCount,
        selectedCount,
        // Everything in it is going: a Published one comes off the storefront.
        emptied: selectedCount === itemCount,
      };
    }),
  };
}

function blockedMessage(blocked: { name: string; heldByBookings: number }[]): string {
  const list = blocked.map((b) => `${b.name} (${b.heldByBookings} ${b.heldByBookings === 1 ? "booking" : "bookings"})`).join(", ");
  return (
    `${blocked.length} of the selected ${blocked.length === 1 ? "item is" : "items are"} on bookings that aren't cancelled: ${list}. ` +
    "Remove them from those bookings, or cancel the bookings, or leave them out of the selection. Nothing was deleted."
  );
}

router.post("/bulk-delete/usage", async (req, res) => {
  const itemIds = readItemIds(req.body);
  if (typeof itemIds === "string") return res.status(400).json({ error: itemIds });
  const account = await getDefaultAccount();
  const usage = await describeBulkUsage(prisma, account.id, itemIds);
  if (usage.items.length !== itemIds.length) {
    return res.status(400).json({ error: "itemIds must all be items on this account" });
  }
  res.json(usage);
});

router.post("/bulk-delete", async (req, res) => {
  const itemIds = readItemIds(req.body);
  if (typeof itemIds === "string") return res.status(400).json({ error: itemIds });
  const account = await getDefaultAccount();

  class Blocked extends Error {
    readonly blocked: { id: string; name: string; heldByBookings: number }[];
    constructor(blocked: { id: string; name: string; heldByBookings: number }[]) {
      super("blocked");
      this.blocked = blocked;
    }
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the selection's units first. A booking takes units with
        // FOR UPDATE SKIP LOCKED, so it passes over these instead of
        // slipping in between the check below and the delete.
        await tx.$queryRaw`SELECT id FROM units WHERE item_id = ANY(${itemIds}::text[]) ORDER BY id FOR UPDATE`;
        const usage = await describeBulkUsage(tx, account.id, itemIds);
        if (usage.items.length !== itemIds.length) throw new Error("itemIds must all be items on this account");
        if (usage.blocked.length > 0) throw new Blocked(usage.blocked);

        await tx.item.deleteMany({ where: { id: { in: itemIds }, accountId: account.id } });

        // The cascade removed the selection's package rows. A Published
        // package left with nothing comes off the storefront as a Draft.
        const unpublished: { id: string; name: string }[] = [];
        for (const pkg of usage.packages) {
          if (pkg.status !== "Published") continue;
          const remaining = await tx.packageItem.count({ where: { packageId: pkg.id } });
          if (remaining === 0) {
            await tx.package.update({ where: { id: pkg.id }, data: { status: "Draft" } });
            unpublished.push({ id: pkg.id, name: pkg.name });
          }
        }
        return { deleted: usage.items.length, removedFrom: usage.packages.map((pkg) => ({ id: pkg.id, name: pkg.name })), unpublished };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Blocked) {
      return res.status(409).json({ error: blockedMessage(err.blocked), reason: "in-use", blocked: err.blocked });
    }
    if (err instanceof Error && err.message === "itemIds must all be items on this account") {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

export default router;
