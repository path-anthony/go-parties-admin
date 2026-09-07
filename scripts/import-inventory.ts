// Imports items into the Item table. Supports two source formats,
// auto-detected from the columns present:
//
//   1. The legacy "All Items" sheet from GEG-Master-Inventory-v2.xlsx
//      (columns: Item, Category, Price ($), Price Unit, Owned vs Partner,
//      Notes, plus audit-trail columns this script drops: Source Deck,
//      Year, Prior Price, Prior Source, Conflict).
//   2. The clean template format (data/item-import-template.csv: name,
//      category, price, price_unit, notes, photo_url) — what
//      /api/items/export.csv produces, so an exported catalog can be
//      handed to Andy, edited, and re-imported with this same script.
//
// Usage: npm run import:inventory -- /path/to/file.xlsx (or .csv)
//
// Every column beyond the item name is optional in both formats: a
// missing or unrecognized value is left null on the Item, never guessed
// and never a reason to fail the row. Only a missing name skips a row
// (or, if the whole file has no recognizable name column, fails fast
// with a clear error instead of silently importing nothing).
//
// The legacy format has one more mess this script works around: some
// rows have a bare number in "Price Unit" and nothing in "Price ($)"
// (e.g. Corn Hole: price unit "90"). That's the price, shifted one
// column left by a data-entry slip. Recovered as the price, flagged
// as a warning.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { utils, read } from "xlsx";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SEED_ACCOUNT_EMAIL = "info@thegoeventgroup.com";
const NON_ITEM_NAME_LENGTH = 150; // legend/footnote rows read as one long sentence

type LegacyRow = {
  Item?: string;
  Category?: string;
  "Price ($)"?: number | string;
  "Price Unit"?: number | string;
  "Owned vs Partner"?: string;
  Notes?: string;
};

type TemplateRow = {
  name?: string;
  category?: string;
  price?: number | string;
  price_unit?: string;
  notes?: string;
  photo_url?: string;
};

type MappedRow = {
  name: string;
  category: string;
  price?: number;
  priceUnit?: string;
  notes?: string;
  photoUrl?: string;
  warning?: string;
};

type ImportOutcome =
  | { status: "imported"; name: string; warning?: string }
  | { status: "skipped"; name: string; reason: string }
  | { status: "failed"; name: string; reason: string };

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") return String(value);
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function mapLegacyRow(row: LegacyRow): MappedRow | null {
  const name = toTrimmedString(row.Item);
  if (!name) return null;

  const category = toTrimmedString(row.Category) ?? "Uncategorized";

  const numericPrice = toNumber(row["Price ($)"]);
  const rawUnit = row["Price Unit"];
  const numericUnit = toNumber(rawUnit);
  const textUnit = toTrimmedString(rawUnit);

  let price: number | undefined;
  let priceUnit: string | undefined;
  let warning: string | undefined;

  if (numericPrice !== undefined) {
    price = numericPrice;
    priceUnit = textUnit;
  } else if (numericUnit !== undefined) {
    price = numericUnit;
    warning = `price recovered from "Price Unit" column (was ${numericUnit}, "Price ($)" was empty)`;
  } else {
    priceUnit = textUnit;
  }

  const ownedTag = toTrimmedString(row["Owned vs Partner"]);
  const notesText = toTrimmedString(row.Notes);
  const notes = ownedTag && notesText ? `${ownedTag}. ${notesText}` : (ownedTag ?? notesText);

  if (!toTrimmedString(row.Category)) {
    warning = "imported with default category (source row had none)";
  }

  return { name, category, price, priceUnit, notes, warning };
}

function mapTemplateRow(row: TemplateRow): MappedRow | null {
  const name = toTrimmedString(row.name);
  if (!name) return null;

  const category = toTrimmedString(row.category) ?? "Uncategorized";

  const rawPrice = row.price;
  const numericPrice = toNumber(rawPrice);
  let warning: string | undefined;
  if (numericPrice === undefined && toTrimmedString(rawPrice) !== undefined) {
    warning = `price column had a non-numeric value ("${toTrimmedString(rawPrice)}"), left blank`;
  }
  if (!toTrimmedString(row.category)) {
    warning = "imported with default category (source row had none)";
  }

  return {
    name,
    category,
    price: numericPrice,
    priceUnit: toTrimmedString(row.price_unit),
    notes: toTrimmedString(row.notes),
    photoUrl: toTrimmedString(row.photo_url),
    warning,
  };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run import:inventory -- /path/to/file.xlsx (or .csv)");
    process.exit(1);
  }

  const account = await prisma.account.findUnique({ where: { email: SEED_ACCOUNT_EMAIL } });
  if (!account) {
    console.error(`No seeded account found (${SEED_ACCOUNT_EMAIL}). Run "npm run db:seed" first.`);
    process.exit(1);
  }

  const workbook = read(readFileSync(filePath));
  const sheetName = workbook.SheetNames.includes("All Items") ? "All Items" : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.error(`No readable sheet found in ${filePath}.`);
    process.exit(1);
  }

  const headerRow = (utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] ?? []).map(String);
  const format: "legacy" | "template" | null = headerRow.includes("Item")
    ? "legacy"
    : headerRow.includes("name")
      ? "template"
      : null;

  if (!format) {
    console.error(
      `Unrecognized columns in "${sheetName}": ${headerRow.join(", ")}\n` +
        `Expected either "Item" (legacy master-inventory format) or "name" (item-import-template.csv format).`,
    );
    process.exit(1);
  }

  const rows =
    format === "legacy"
      ? utils.sheet_to_json<LegacyRow>(sheet, { defval: undefined })
      : utils.sheet_to_json<TemplateRow>(sheet, { defval: undefined });
  const mapRow = format === "legacy" ? mapLegacyRow : mapTemplateRow;

  const outcomes: ImportOutcome[] = [];

  for (const row of rows) {
    const mapped = mapRow(row as never);
    if (!mapped) continue; // no name: blank/spacer row

    if (mapped.name.length > NON_ITEM_NAME_LENGTH) {
      outcomes.push({ status: "skipped", name: mapped.name, reason: "reads as a legend/footnote, not an item" });
      continue;
    }

    try {
      await prisma.item.create({
        data: {
          accountId: account.id,
          name: mapped.name,
          category: mapped.category,
          price: mapped.price,
          priceUnit: mapped.priceUnit,
          notes: mapped.notes,
          photoUrl: mapped.photoUrl,
        },
      });
      outcomes.push({ status: "imported", name: mapped.name, warning: mapped.warning });
    } catch (error) {
      outcomes.push({
        status: "failed",
        name: mapped.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const imported = outcomes.filter((o) => o.status === "imported");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  const failed = outcomes.filter((o) => o.status === "failed");
  const warnings = imported.filter((o) => o.status === "imported" && o.warning);

  if (rows.length > 0 && outcomes.length === 0) {
    console.error(
      `Found the "${format === "legacy" ? "Item" : "name"}" column, but every row's value in it was empty. Nothing imported.`,
    );
    process.exit(1);
  }

  console.log(
    `\nImported ${imported.length} of ${rows.length} sheet rows (${format} format) into account "${account.name}".`,
  );

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} imported with a note:`);
    for (const o of warnings) {
      if (o.status === "imported") console.log(`  - ${o.name}: ${o.warning}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.length} rows skipped (not items):`);
    for (const o of skipped) {
      if (o.status === "skipped") console.log(`  - ${o.name.slice(0, 60)}...: ${o.reason}`);
    }
  }

  if (failed.length > 0) {
    console.log(`\n${failed.length} rows FAILED to import:`);
    for (const o of failed) {
      if (o.status === "failed") console.log(`  - ${o.name}: ${o.reason}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
