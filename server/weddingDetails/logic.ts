import { addDays, atEastern, humanDay } from "../automation/time.js";
import { prettyPhone } from "../messageContext.js";
import { safeInline, safeText, stripControl, stripControlKeepNewlines } from "../sanitize.js";
import { groupsOf } from "../../src/lib/occasions.js";
import { DUE_DAYS_BEFORE, allFields, sectionFields, type Field, type Section, type Template } from "./template.js";

// The rules of the wedding questionnaire, with no database and no clock.

export type Answers = Record<string, unknown>;
export type WeddingStatus = "not_started" | "in_progress" | "submitted";

// ---- Which bookings are weddings ---------------------------------------

type WeddingFacts = { weddingOverride: boolean | null; occasion: string | null; package?: { occasions: string[] } | null };

const isWeddingOccasion = (occasion: string) => groupsOf(occasion).includes("Wedding");

// What the booking itself says, before any staff override. The occasion the
// booking was made for decides when it has one: a corporate booking of a
// package that is also sold for weddings is not a wedding. The package's
// occasions count only when the booking has none.
export function automaticWedding(b: Pick<WeddingFacts, "occasion" | "package">): boolean {
  if (b.occasion && b.occasion.trim() !== "") return isWeddingOccasion(b.occasion);
  return (b.package?.occasions ?? []).some(isWeddingOccasion);
}

// Staff can say yes or no; null means the automatic rule decides.
export function isWeddingBooking(b: WeddingFacts): boolean {
  return b.weddingOverride ?? automaticWedding(b);
}

// ---- Dates --------------------------------------------------------------

export const dueDateFor = (eventDay: string) => addDays(eventDay, -DUE_DAYS_BEFORE);
export const dayLabel = (day: string) => humanDay(atEastern(day, 12));

// ---- Prefill ------------------------------------------------------------

export type PrefillSource = {
  eventDay: string;
  address: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  mailingAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  customer?: { name: string | null; email: string; phone: string; homeAddress: string | null } | null;
};

// What the booking and the account already know. Each key returned is shown
// read-only and refused on a save. A key with nothing to show is left out,
// so the customer can still fill it in. Never stored as an answer: a change
// to the booking shows here at once.
export function prefillFor(b: PrefillSource): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    if (value && value.trim() !== "") out[key] = value.trim();
  };
  put("couple.bride_name", b.customer?.name ?? b.customerName);
  put("couple.bride_email", b.customer?.email ?? b.email);
  put("couple.bride_cell", prettyPhone(b.customer?.phone ?? b.phone));
  // The account's home address is one line. The contract's mailing address
  // comes with its city, state and zip, so those only apply alongside it.
  if (b.customer?.homeAddress) put("couple.bride_address", b.customer.homeAddress);
  else {
    put("couple.bride_address", b.mailingAddress);
    if (b.mailingAddress) {
      put("couple.bride_city", b.city);
      put("couple.bride_state", b.state);
      put("couple.bride_zip", b.zip);
    }
  }
  put("cover.event_date", dayLabel(b.eventDay));
  put("cover.reception_venue", b.address);
  put("wedding_info.reception_location", b.address);
  return out;
}

// ---- Saving answers -----------------------------------------------------

export type AnswerProblem = { reason: "not-an-object" | "unknown-field" | "locked-field" | "invalid-answer" | "too-long"; field: string | null; error: string };

function cleanText(f: Field, raw: string): string {
  const max = f.max ?? 300;
  if (f.type === "textarea") return f.keepLinks ? stripControlKeepNewlines(raw).trim() : safeText(raw, max);
  return f.keepLinks ? stripControl(raw, max) : safeInline(raw, max);
}

// One answer: the value to store, null to clear it, or a problem.
function cleanValue(f: Field, value: unknown): { value: unknown } | AnswerProblem {
  const bad = (error: string, reason: AnswerProblem["reason"] = "invalid-answer"): AnswerProblem => ({ reason, field: f.key, error });
  if (value === null || value === undefined) return { value: null };
  switch (f.type) {
    case "text":
    case "time":
    case "textarea":
    case "handle": {
      if (typeof value !== "string") return bad(`${f.key} must be text`);
      if (value.trim().length > (f.max ?? 300)) return bad(`${f.key} must be ${f.max ?? 300} characters or fewer`, "too-long");
      const text = cleanText(f, value);
      return { value: text === "" ? null : text };
    }
    case "checkbox":
      if (typeof value !== "boolean") return bad(`${f.key} must be true or false`);
      return { value: value ? true : null };
    case "choice":
      if (value === "") return { value: null };
      if (typeof value !== "string" || !f.options?.some((o) => o.value === value)) return bad(`${f.key} must be one of ${f.options?.map((o) => o.value).join(", ")}`);
      return { value };
    case "multi": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && f.options?.some((o) => o.value === v))) return bad(`${f.key} must be a list from ${f.options?.map((o) => o.value).join(", ")}`);
      const unique = [...new Set(value as string[])];
      return { value: unique.length === 0 ? null : unique };
    }
    case "rank": {
      if (typeof value !== "object" || Array.isArray(value)) return bad(`${f.key} must give each choice a rank`);
      const entries = Object.entries(value as Record<string, unknown>).filter(([, n]) => n !== null && n !== "");
      const size = f.options?.length ?? 0;
      for (const [k, n] of entries) {
        if (!f.options?.some((o) => o.value === k)) return bad(`${f.key} has no choice called ${k}`);
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > size) return bad(`${f.key} ranks must be whole numbers from 1 to ${size}`);
      }
      const ranks = entries.map(([, n]) => n);
      if (new Set(ranks).size !== ranks.length) return bad(`${f.key} can use each rank once`);
      return { value: entries.length === 0 ? null : Object.fromEntries(entries) };
    }
  }
}

// A partial save, checked whole: one bad field refuses all of it. A null
// value means the field was cleared.
export function cleanAnswers(t: Template, patch: unknown, locked: Set<string>): { values: Record<string, unknown> } | AnswerProblem {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { reason: "not-an-object", field: null, error: "answers must be an object of field keys and values" };
  const fields = new Map(allFields(t).map((f) => [f.key, f]));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.get(key);
    if (!f) return { reason: "unknown-field", field: key, error: `${key} is not a field on this form` };
    if (locked.has(key)) return { reason: "locked-field", field: key, error: `${key} comes from the booking and can't be changed here` };
    const cleaned = cleanValue(f, value);
    if ("reason" in cleaned) return cleaned;
    values[key] = cleaned.value;
  }
  return { values };
}

export function mergeAnswers(current: Answers, values: Record<string, unknown>): Answers {
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

// ---- Progress -----------------------------------------------------------

// Only what the customer answered counts. Prefilled details are not stored,
// so a section the booking half-fills is not done until they add to it.
export function sectionProgress(t: Template, answers: Answers) {
  const sections = t.sections.map((s) => ({ key: s.key, number: s.number, title: s.title, required: s.required, done: sectionFields(s).some((f) => answers[f.key] !== undefined) }));
  const required = sections.filter((s) => s.required);
  return { sections, requiredDone: required.filter((s) => s.done).length, requiredTotal: required.length, missing: required.filter((s) => !s.done).map((s) => ({ key: s.key, title: s.title })) };
}

// ---- Showing answers ----------------------------------------------------

export type ShownRow = { group: string | null; label: string; value: string | null };
export type ShownSection = { key: string; number: number; title: string; subtitle: string; required: boolean; done: boolean; rows: ShownRow[] };

function display(f: Field, value: unknown): string | null {
  switch (f.type) {
    case "checkbox":
      return null;
    case "choice":
      return f.options?.find((o) => o.value === value)?.label ?? String(value);
    case "multi":
      return (value as string[]).map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join(", ");
    case "rank":
      return Object.entries(value as Record<string, number>)
        .sort((a, b) => a[1] - b[1])
        .map(([k, n]) => `${n}. ${f.options?.find((o) => o.value === k)?.label ?? k}`)
        .join(", ");
    case "handle":
      return `${f.prefix ?? ""}${String(value).replace(/^[@#]/, "")}`;
    default:
      return String(value);
  }
}

// In section order, only what is ticked or filled, for staff and the print
// page. Prefilled details are included. A ticked box has no value: its label
// is the answer.
export function shownSections(t: Template, answers: Answers, prefill: Record<string, string>): ShownSection[] {
  const has = (k: string) => answers[k] !== undefined || prefill[k] !== undefined;
  const val = (k: string) => prefill[k] ?? answers[k];
  const done = new Map(sectionProgress(t, answers).sections.map((s) => [s.key, s.done]));
  const rowsOf = (s: Section): ShownRow[] =>
    s.items.flatMap((it): ShownRow[] => {
      if (it.kind === "field") return has(it.key) ? [{ group: null, label: it.label, value: display(it, val(it.key)) }] : [];
      if (it.kind === "group") return it.fields.filter((f) => has(f.key)).map((f) => ({ group: it.title, label: f.label, value: null }));
      return [];
    });
  return t.sections.map((s) => ({ key: s.key, number: s.number, title: s.title, subtitle: s.subtitle, required: s.required, done: done.get(s.key) ?? false, rows: rowsOf(s) }));
}
