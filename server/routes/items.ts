import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { ADDON_GROUPS_INCLUDE } from "../addons.js";
import { TEMPLATE_HEADERS, importCsv, previewCsv } from "../bulkItems.js";
import { toCsv } from "../csv.js";
import { prisma } from "../db.js";
import { isSkill } from "../skills.js";

const CSV_HEADERS = ["name", "category", "price", "price_unit", "notes", "photo_url"];

const router = Router();

const EDITABLE_FIELDS = ["name", "category", "price", "priceUnit", "notes", "photoUrl", "skills"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

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
  const { name, category, price, priceUnit, notes, photoUrl, skills, startingUnits } = req.body ?? {};

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
  if (skills !== undefined && (!Array.isArray(skills) || !skills.every(isSkill))) {
    return res.status(400).json({ error: "skills must be a list of crew skills" });
  }
  const skillList: string[] = skills === undefined ? [] : [...new Set(skills as string[])];
  let unitCount = 1;
  if (startingUnits !== undefined) {
    if (!Number.isInteger(startingUnits) || startingUnits < 0 || startingUnits > MAX_STARTING_UNITS) {
      return res.status(400).json({ error: `startingUnits must be a whole number from 0 to ${MAX_STARTING_UNITS}` });
    }
    unitCount = startingUnits;
  }
  if (skillList.length > 0) unitCount = 0;

  const account = await getDefaultAccount();
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        accountId: account.id,
        name: name.trim(),
        category: category.trim(),
        price: normalizedPrice,
        priceUnit: normalizeText(priceUnit),
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

  const data: Record<string, string | number | string[] | null> = {};

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
      const skills = body.skills;
      if (!Array.isArray(skills) || !skills.every(isSkill)) {
        return res.status(400).json({ error: "skills must be a list of crew skills" });
      }
      data.skills = [...new Set(skills)];
      continue;
    }

    data[field as Exclude<EditableField, "price" | "name" | "category">] = normalizeText(body[field]);
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

export default router;
