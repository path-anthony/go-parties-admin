import { prisma } from "../db.js";
import type { ServiceRowDef } from "./goDocument.js";
import { GO_TEMPLATE_V1, SERVICE_ROWS_SEED, type GoTermsContent } from "./goTemplate.js";

// The GO contract's wording and its service rows, as stored. The wording is
// versioned like the policy text: a save adds a version, never edits one, and
// an agreement pins the version its link was prepared with. Version 1 is
// seeded from the template the first time anything asks, and so are the
// service rows, so a fresh account prints the client's contract as is.

export const MAX_CLAUSES = 40;
export const MAX_TEXT = 4000;

export type TermsVersionRow = { id: string; version: number; content: GoTermsContent; createdAt: Date };

const asContent = (v: unknown): GoTermsContent => v as GoTermsContent;

export async function currentTerms(accountId: string): Promise<TermsVersionRow> {
  const latest = await prisma.contractTermsVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (latest) return { ...latest, content: asContent(latest.content) };
  try {
    const row = await prisma.contractTermsVersion.create({ data: { accountId, version: 1, content: GO_TEMPLATE_V1 } });
    return { ...row, content: asContent(row.content) };
  } catch (err) {
    if ((err as { code?: unknown }).code === "P2002") {
      const row = await prisma.contractTermsVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
      return { ...row, content: asContent(row.content) };
    }
    throw err;
  }
}

export async function termsVersionById(id: string): Promise<TermsVersionRow | null> {
  const row = await prisma.contractTermsVersion.findUnique({ where: { id } });
  return row ? { ...row, content: asContent(row.content) } : null;
}

export async function listTermsVersions(accountId: string) {
  await currentTerms(accountId);
  const rows = await prisma.contractTermsVersion.findMany({ where: { accountId }, orderBy: { version: "desc" }, include: { _count: { select: { agreements: true } } } });
  return rows.map((r) => ({ id: r.id, version: r.version, content: asContent(r.content), createdAt: r.createdAt, agreements: r._count.agreements }));
}

// Checks a submitted template's shape and sizes. Returns a message on the
// first problem.
export function validateTerms(value: unknown): GoTermsContent | string {
  const v = value as Partial<GoTermsContent> | null;
  if (!v || typeof v !== "object") return "the contract terms are missing";
  const text = (x: unknown, what: string, max = MAX_TEXT): string | null => (typeof x === "string" && x.length <= max ? x : `${what} must be text up to ${max} characters`);
  const problems: string[] = [];
  const take = (x: unknown, what: string, max = MAX_TEXT): string => {
    const t = text(x, what, max);
    if (t === null || t.startsWith(what)) {
      problems.push(t ?? `${what} is missing`);
      return "";
    }
    return t;
  };
  const h = v.header ?? ({} as GoTermsContent["header"]);
  const t = v.terms ?? ({} as GoTermsContent["terms"]);
  const a = v.acceptance ?? ({} as GoTermsContent["acceptance"]);
  const out: GoTermsContent = {
    header: { title: take(h.title, "header title", 200), confirmByLine: take(h.confirmByLine, "confirm-by line", 400), nonRefundableLine: take(h.nonRefundableLine, "non-refundable line", 200) },
    terms: {
      heading: take(t.heading, "terms heading", 200),
      pageHeader: take(t.pageHeader, "page header", 200),
      pageSubheader: take(t.pageSubheader, "page subheader", 400),
      clauses: [],
    },
    servicesNote: take(v.servicesNote, "services note"),
    paymentNote: take(v.paymentNote, "payment note"),
    acceptance: {
      heading: take(a.heading, "acceptance heading", 200),
      text: take(a.text, "acceptance text"),
      esignLabel: take(a.esignLabel, "e-sign label", 400),
      confirmLine: take(a.confirmLine, "confirm line", 400),
      nonRefundableLine: take(a.nonRefundableLine, "closing line", 200),
    },
  };
  if (!Array.isArray(t.clauses) || t.clauses.length === 0 || t.clauses.length > MAX_CLAUSES) return `clauses must be a list of 1 to ${MAX_CLAUSES}`;
  for (const [i, c] of t.clauses.entries()) {
    const cc = (c ?? {}) as Partial<{ title: string; body: string }>;
    const title = take(cc.title, `clause ${i + 1} title`, 200).trim();
    const body = take(cc.body, `clause ${i + 1} body`).trim();
    if (title === "" || body === "") problems.push(`clause ${i + 1} needs a title and a body`);
    out.terms.clauses.push({ title, body });
  }
  return problems.length > 0 ? problems[0] : out;
}

export async function saveTerms(accountId: string, content: GoTermsContent): Promise<{ created: boolean; version: TermsVersionRow }> {
  const current = await currentTerms(accountId);
  if (JSON.stringify(current.content) === JSON.stringify(content)) return { created: false, version: current };
  const row = await prisma.contractTermsVersion.create({ data: { accountId, version: current.version + 1, content } });
  return { created: true, version: { ...row, content: asContent(row.content) } };
}

// ---- service rows ------------------------------------------------------------------

export async function serviceRows(accountId: string): Promise<ServiceRowDef[]> {
  let rows = await prisma.contractServiceRow.findMany({ where: { accountId }, orderBy: [{ column: "asc" }, { position: "asc" }] });
  if (rows.length === 0) {
    await prisma.contractServiceRow.createMany({
      data: SERVICE_ROWS_SEED.map((s, i) => ({ accountId, column: s.column, position: i, label: s.label, isGroupHeading: s.isGroupHeading === true, categories: s.categories ?? [], itemWords: s.itemWords ?? [] })),
      skipDuplicates: true,
    });
    rows = await prisma.contractServiceRow.findMany({ where: { accountId }, orderBy: [{ column: "asc" }, { position: "asc" }] });
  }
  return rows.map((r) => ({ id: r.id, column: r.column === "right" ? "right" : "left", position: r.position, label: r.label, isGroupHeading: r.isGroupHeading, categories: r.categories, itemWords: r.itemWords, itemIds: r.itemIds }));
}

export type ServiceRowInput = { id?: string; column: "left" | "right"; label: string; isGroupHeading?: boolean; categories?: string[]; itemWords?: string[]; itemIds?: string[] };

export function validateServiceRows(value: unknown): ServiceRowInput[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 60) return "rows must be a list of 1 to 60";
  const out: ServiceRowInput[] = [];
  const list = (x: unknown, what: string) => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || !x.every((s): s is string => typeof s === "string" && s.length <= 120)) throw new Error(`${what} must be a list of short text`);
    return x.map((s) => s.trim()).filter(Boolean);
  };
  try {
    for (const [i, raw] of value.entries()) {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (r.column !== "left" && r.column !== "right") return `row ${i + 1}: column must be left or right`;
      if (typeof r.label !== "string" || r.label.trim() === "" || r.label.length > 120) return `row ${i + 1}: label is required, up to 120 characters`;
      if (r.isGroupHeading !== undefined && typeof r.isGroupHeading !== "boolean") return `row ${i + 1}: isGroupHeading must be true or false`;
      out.push({
        id: typeof r.id === "string" ? r.id : undefined,
        column: r.column,
        label: r.label.trim(),
        isGroupHeading: r.isGroupHeading === true,
        categories: list(r.categories, `row ${i + 1} categories`),
        itemWords: list(r.itemWords, `row ${i + 1} item words`),
        itemIds: list(r.itemIds, `row ${i + 1} items`),
      });
    }
  } catch (err) {
    return err instanceof Error ? err.message : "rows are not valid";
  }
  return out;
}

// Replaces the whole list in one transaction, keeping ids where the client
// sent them (so a booking's per-row overrides keep pointing at their rows).
export async function saveServiceRows(accountId: string, rows: ServiceRowInput[]): Promise<ServiceRowDef[]> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.contractServiceRow.findMany({ where: { accountId }, select: { id: true } });
    const keep = new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
    await tx.contractServiceRow.deleteMany({ where: { accountId, id: { notIn: [...keep] } } });
    let position = 0;
    for (const r of rows) {
      const data = { column: r.column, position: position++, label: r.label, isGroupHeading: r.isGroupHeading === true, categories: r.categories ?? [], itemWords: r.itemWords ?? [], itemIds: r.itemIds ?? [] };
      if (r.id && existing.some((e) => e.id === r.id)) await tx.contractServiceRow.update({ where: { id: r.id }, data });
      else await tx.contractServiceRow.create({ data: { accountId, ...data } });
    }
  });
  return serviceRows(accountId);
}
