import { prisma } from "./db.js";
import { listSkillNames } from "./skills.js";

// The bulk importer behind Inventory's "Bulk add items" and behind
// one-off imports. One parser, one validation, one creation rule, so a
// file behaves the same whichever way it comes in.

export const TEMPLATE_HEADERS = ["name", "category", "price", "billed_per", "skills", "starting_units", "notes"] as const;
export const MAX_ROWS = 1000;
const MAX_STARTING_UNITS = 50;
const MAX_TEXT = 500;
const MAX_NOTES = 5000;

// A small RFC 4180 reader: quoted fields, doubled quotes inside them,
// newlines inside quotes, CRLF or LF line ends, a UTF-8 BOM. Returns rows
// of fields; blank lines are dropped.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export type RowResult = {
  line: number; // 1-based line in the file, header is line 1
  name: string;
  category: string; // as resolved: the existing category's casing, or the new name
  categoryNew: boolean;
  price: number | null;
  billedPer: string | null;
  skills: string[];
  startingUnits: number;
  notes: string | null;
  // Empty means the row will be created. Otherwise every reason it won't.
  problems: string[];
};

export type Preview = {
  headers: string[];
  missingHeaders: string[];
  rows: RowResult[];
  creatable: number;
  categoriesNew: string[];
  categoriesReused: string[];
};

// Reads the file against the catalog as it is now: existing names are
// skipped (so a re-run creates no duplicates), categories are matched
// case-insensitively and reused, and every problem a row has is named.
// Nothing is written.
export async function previewCsv(text: string, accountId: string): Promise<Preview> {
  const parsed = parseCsv(text);
  const headerRow = (parsed[0] ?? []).map((h) => h.trim().toLowerCase());
  const missingHeaders = ["name", "category", "price"].filter((h) => !headerRow.includes(h));
  const col = (name: string) => headerRow.indexOf(name);
  const idx = Object.fromEntries(TEMPLATE_HEADERS.map((h) => [h, col(h)])) as Record<(typeof TEMPLATE_HEADERS)[number], number>;
  // The old template's names for two columns are accepted too.
  if (idx.billed_per < 0) idx.billed_per = col("price_unit");

  const [existingItems, existingCategoryRows, skillNames] = await Promise.all([
    prisma.item.findMany({ where: { accountId }, select: { name: true } }),
    prisma.item.findMany({ where: { accountId }, distinct: ["category"], select: { category: true } }),
    listSkillNames(accountId),
  ]);
  const knownSkills = new Set(skillNames);
  const existingNames = new Set(existingItems.map((i) => i.name.trim().toLowerCase()));
  // lowercase -> canonical casing. New categories found in the file are
  // added as they appear, so later rows reuse the first row's spelling.
  const categories = new Map(existingCategoryRows.map((r) => [r.category.toLowerCase(), r.category]));
  const categoriesNew = new Set<string>();
  const categoriesReused = new Set<string>();
  const seenInFile = new Set<string>();

  const rows: RowResult[] = [];
  const dataRows = parsed.slice(1);
  for (let n = 0; n < dataRows.length && n < MAX_ROWS; n++) {
    const cells = dataRows[n];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : "");
    const problems: string[] = [];
    const name = get(idx.name);
    const categoryText = get(idx.category);
    const priceText = get(idx.price);
    const billedPer = get(idx.billed_per) || null;
    const skillsText = get(idx.skills);
    const unitsText = get(idx.starting_units);
    const notes = get(idx.notes) || null;

    if (!name) problems.push("name is missing");
    else if (name.length > MAX_TEXT) problems.push(`name is over ${MAX_TEXT} characters`);
    if (!categoryText) problems.push("category is missing");
    let price: number | null = null;
    if (!priceText) problems.push("price is missing");
    else {
      const num = Number(priceText.replace(/^\$/, "").replace(/,/g, ""));
      if (!Number.isFinite(num) || num < 0) problems.push(`price "${priceText}" is not a number`);
      else price = Math.round(num * 100) / 100;
    }
    if (billedPer && billedPer.length > MAX_TEXT) problems.push(`billed_per is over ${MAX_TEXT} characters`);
    if (notes && notes.length > MAX_NOTES) problems.push(`notes are over ${MAX_NOTES} characters`);

    const skills = skillsText
      ? [...new Set(skillsText.split(/[,;|]/).map((s) => s.trim()).filter((s) => s !== ""))]
      : [];
    const unknown = skills.filter((s) => !knownSkills.has(s));
    if (unknown.length > 0) {
      problems.push(`unknown skill${unknown.length === 1 ? "" : "s"} ${unknown.map((s) => `"${s}"`).join(", ")} (known: ${skillNames.join(", ")})`);
    }

    let startingUnits = 1;
    if (unitsText !== "") {
      const num = Number(unitsText);
      if (!Number.isInteger(num) || num < 0 || num > MAX_STARTING_UNITS) {
        problems.push(`starting_units "${unitsText}" must be a whole number from 0 to ${MAX_STARTING_UNITS}`);
      } else startingUnits = num;
    }
    if (skills.length > 0 && unknown.length === 0) startingUnits = 0;

    const key = name.toLowerCase();
    if (name && existingNames.has(key)) problems.push("an item with this name already exists in the catalog");
    else if (name && seenInFile.has(key)) problems.push("the same name appears earlier in this file");
    if (name) seenInFile.add(key);

    // Category resolution only counts for rows that will be created.
    let category = categoryText;
    let categoryNew = false;
    if (categoryText) {
      const canonical = categories.get(categoryText.toLowerCase());
      if (canonical) {
        category = canonical;
        if (problems.length === 0) categoriesReused.add(canonical);
      } else if (problems.length === 0) {
        categoryNew = true;
        categoriesNew.add(categoryText);
        categories.set(categoryText.toLowerCase(), categoryText);
      } else {
        categoryNew = true;
      }
    }

    rows.push({ line: n + 2, name, category, categoryNew, price, billedPer, skills, startingUnits, notes, problems });
  }

  return {
    headers: headerRow,
    missingHeaders,
    rows,
    creatable: rows.filter((r) => r.problems.length === 0).length,
    categoriesNew: [...categoriesNew],
    categoriesReused: [...categoriesReused].sort((a, b) => a.localeCompare(b)),
  };
}

export type ImportSummary = {
  created: number;
  skipped: { line: number; name: string; reasons: string[] }[];
  categoriesNew: string[];
  categoriesReused: string[];
  itemIds: string[];
};

// Creates every row the preview would create, in one transaction: an
// item with skills gets no units; any other gets starting_units of them
// (1 when blank), labelled "Unit #1", "Unit #2". Rows with problems are
// reported, never created.
export async function importCsv(text: string, accountId: string): Promise<ImportSummary> {
  const preview = await previewCsv(text, accountId);
  const good = preview.rows.filter((r) => r.problems.length === 0);
  // Two statements, not two per row: a few hundred rows one at a time
  // over the network would outlast the transaction. Names are unique
  // within the good rows (the preview guarantees it), so the returned
  // items map back to their rows by name.
  const itemIds = await prisma.$transaction(
    async (tx) => {
      if (good.length === 0) return [];
      const created = await tx.item.createManyAndReturn({
        data: good.map((row) => ({
          accountId,
          name: row.name,
          category: row.category,
          price: row.price,
          priceUnit: row.billedPer,
          notes: row.notes,
          skills: row.skills,
        })),
        select: { id: true, name: true },
      });
      const idByName = new Map(created.map((c) => [c.name, c.id]));
      const units = good.flatMap((row) => {
        const itemId = idByName.get(row.name);
        if (!itemId) return [];
        return Array.from({ length: row.startingUnits }, (_, n) => ({ itemId, label: `Unit #${n + 1}`, status: "Available" }));
      });
      if (units.length > 0) await tx.unit.createMany({ data: units });
      return good.map((row) => idByName.get(row.name)).filter((id): id is string => !!id);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return {
    created: itemIds.length,
    skipped: preview.rows.filter((r) => r.problems.length > 0).map((r) => ({ line: r.line, name: r.name, reasons: r.problems })),
    categoriesNew: preview.categoriesNew,
    categoriesReused: preview.categoriesReused,
    itemIds,
  };
}
