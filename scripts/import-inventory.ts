// Imports items from the GEG master inventory spreadsheet into the Item
// table. Usage: npm run import:inventory -- /path/to/GEG-Master-Inventory-v2.xlsx
//
// Reads the "All Items" sheet only. Maps its columns onto the clean Item
// schema and drops the audit-trail columns (Source Deck, Year, Prior Price,
// Prior Source, Conflict) that only existed to help build the sheet by hand.
//
// The source sheet has two known messes this script works around rather
// than failing on:
//   - Some rows have a bare number in "Price Unit" and nothing in
//     "Price ($)" (e.g. Corn Hole: price unit "90"). That's the price,
//     shifted one column left by a data-entry slip. Recovered as the price.
//   - Most rows have no numeric price at all (TBD, "Custom quote", a rate
//     description like "475 per day 650 for weekend"). Those are kept as
//     free-text in price_unit with price left null, not invented.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { utils, read } from "xlsx";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SHEET_NAME = "All Items";
const SEED_ACCOUNT_EMAIL = "info@thegoeventgroup.com";
const NON_ITEM_NAME_LENGTH = 150; // legend/footnote rows read as one long sentence

type SourceRow = {
  Item?: string;
  Category?: string;
  "Price ($)"?: number | string;
  "Price Unit"?: number | string;
  "Owned vs Partner"?: string;
  Notes?: string;
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

function derivePriceFields(row: SourceRow): { price?: number; priceUnit?: string; warning?: string } {
  const numericPrice = toNumber(row["Price ($)"]);
  const rawUnit = row["Price Unit"];
  const numericUnit = toNumber(rawUnit);
  const textUnit = toTrimmedString(rawUnit);

  if (numericPrice !== undefined) {
    return { price: numericPrice, priceUnit: textUnit };
  }

  if (numericUnit !== undefined) {
    return {
      price: numericUnit,
      warning: `price recovered from "Price Unit" column (was ${numericUnit}, "Price ($)" was empty)`,
    };
  }

  return { priceUnit: textUnit };
}

function deriveNotes(row: SourceRow): string | undefined {
  const ownedTag = toTrimmedString(row["Owned vs Partner"]);
  const notes = toTrimmedString(row.Notes);
  if (ownedTag && notes) return `${ownedTag}. ${notes}`;
  return ownedTag ?? notes;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run import:inventory -- /path/to/GEG-Master-Inventory-v2.xlsx");
    process.exit(1);
  }

  const account = await prisma.account.findUnique({ where: { email: SEED_ACCOUNT_EMAIL } });
  if (!account) {
    console.error(`No seeded account found (${SEED_ACCOUNT_EMAIL}). Run "npm run db:seed" first.`);
    process.exit(1);
  }

  const workbook = read(readFileSync(filePath));
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    console.error(`Sheet "${SHEET_NAME}" not found. Sheets in file: ${workbook.SheetNames.join(", ")}`);
    process.exit(1);
  }

  const rows = utils.sheet_to_json<SourceRow>(sheet, { defval: undefined });
  const outcomes: ImportOutcome[] = [];

  for (const row of rows) {
    const name = toTrimmedString(row.Item);

    if (!name) {
      // Fully blank row, e.g. a trailing spacer row.
      continue;
    }

    if (name.length > NON_ITEM_NAME_LENGTH) {
      outcomes.push({ status: "skipped", name, reason: "reads as a legend/footnote, not an item" });
      continue;
    }

    const category = toTrimmedString(row.Category) ?? "Uncategorized";
    const { price, priceUnit, warning } = derivePriceFields(row);
    const notes = deriveNotes(row);

    try {
      await prisma.item.create({
        data: {
          accountId: account.id,
          name,
          category,
          price,
          priceUnit,
          notes,
        },
      });
      outcomes.push({
        status: "imported",
        name,
        warning: category === "Uncategorized" && !toTrimmedString(row.Category)
          ? "imported with default category (source row had none)"
          : warning,
      });
    } catch (error) {
      outcomes.push({
        status: "failed",
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const imported = outcomes.filter((o) => o.status === "imported");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  const failed = outcomes.filter((o) => o.status === "failed");
  const warnings = imported.filter((o) => o.status === "imported" && o.warning);

  console.log(`\nImported ${imported.length} of ${rows.length} sheet rows into account "${account.name}".`);

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
