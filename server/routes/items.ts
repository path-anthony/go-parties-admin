import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { toCsv } from "../csv.js";
import { prisma } from "../db.js";

const CSV_HEADERS = ["name", "category", "price", "price_unit", "notes", "photo_url"];

const router = Router();

const EDITABLE_FIELDS = ["name", "category", "price", "priceUnit", "notes", "photoUrl"] as const;
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

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({
    where: { accountId: account.id },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  res.json(items);
});

router.get("/export.csv", async (_req, res) => {
  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({
    where: { accountId: account.id },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const rows = items.map((item) => [
    item.name,
    item.category,
    item.price?.toString() ?? "",
    item.priceUnit ?? "",
    item.notes ?? "",
    item.photoUrl ?? "",
  ]);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="items-export.csv"');
  res.send(toCsv(CSV_HEADERS, rows));
});

router.post("/", async (req, res) => {
  const { name, category, price, priceUnit, notes, photoUrl } = req.body ?? {};

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

  const account = await getDefaultAccount();
  const item = await prisma.item.create({
    data: {
      accountId: account.id,
      name: name.trim(),
      category: category.trim(),
      price: normalizedPrice,
      priceUnit: normalizeText(priceUnit),
      notes: normalizeText(notes),
      photoUrl: normalizeText(photoUrl),
    },
  });

  res.status(201).json(item);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};

  const existing = await prisma.item.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "item not found" });
  }

  const data: Record<string, string | number | null> = {};

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

    data[field as Exclude<EditableField, "price" | "name" | "category">] = normalizeText(body[field]);
  }

  const item = await prisma.item.update({ where: { id }, data });
  res.json(item);
});

export default router;
