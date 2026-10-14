import { createHash } from "node:crypto";
import { FALLBACK_ROW, GO_TOKENS, type GoTermsContent, type GoTokenValues } from "./goTemplate.js";
import { daysBefore, goTotals, roundHalfUp, toCents, wholeDollars } from "./goMoney.js";

// Composes the GO contract document (the locked "go-v2" format the storefront
// renders) from plain inputs. No database here: server/contract/goLoad.ts
// gathers the booking, settings and terms and calls composeGoDocument.
// Every field is built by name; nothing is spread from a record, so a column
// added later can never reach a customer by accident.

export type Cents = number | "-" | null;

export type GoField = { label: string | null; checked: boolean | null; details: string | null; fee: Cents; isGroupHeading?: boolean | null };
export type GoSignature = { printedName: string | null; signedAt: string | null };

export type GoDocument = {
  header: { title: string | null; confirmByLine: string | null; confirmByDate: string | null; nonRefundableLine: string | null };
  company: { name: string | null; addressLine: string | null; phone: string | null; email: string | null; website: string | null; logoUrl: string | null; footerLine: string | null };
  client: { nameOrg: string | null; email: string | null; mailingAddress: string | null; city: string | null; state: string | null; zip: string | null; phoneHome: string | null; phoneWork: string | null; phoneCell: string | null };
  event: {
    type: string | null;
    guestOfHonor: string | null;
    date: string | null;
    timeFromTo: string | null;
    expectedGuests: string | null;
    ageRange: string | null;
    venueName: string | null;
    venueAddress: string | null;
    venuePhone: string | null;
    onsiteContactName: string | null;
    onsiteContactPhone: string | null;
    planner: string | null;
  };
  specialRequests: string | null;
  services: { left: GoField[]; right: GoField[]; note: string | null };
  payment: {
    subtotal: Cents;
    discountPercent: number | null;
    discountAmount: Cents;
    totalDiscount: Cents;
    discountDescription: string | null;
    total: Cents;
    retainerPercent: number | null;
    retainerAmount: Cents;
    balance: Cents;
    balanceDueDays: number | null;
    balanceDueDate: string | null;
    note: string | null;
  };
  terms: { heading: string | null; pageHeader: string | null; pageSubheader: string | null; clauses: { number: number | string | null; title: string | null; body: string | null }[] };
  acceptance: { heading: string | null; text: string | null; esignLabel: string | null; confirmLine: string | null; nonRefundableLine: string | null };
  signatures: { client: GoSignature | null; additional: GoSignature | null; go: GoSignature | null };
};

// ---- tokens ------------------------------------------------------------------

// "{{retainerPercent}}" and the others, filled from Settings. Unknown tokens
// are left as typed, like the policy text.
export function fillGoTokens(text: string, values: GoTokenValues): string {
  return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (whole, key: string) => {
    if (!(GO_TOKENS as readonly string[]).includes(key)) return whole;
    const v = values[key as keyof GoTokenValues];
    if (key === "returnedCheckFee") return wholeDollars(v).slice(1); // the template writes the "$" itself
    return String(v);
  });
}

// ---- service roll-up -------------------------------------------------------------

export type ServiceRowDef = { id: string; column: "left" | "right"; position: number; label: string; isGroupHeading: boolean; categories: string[]; itemWords: string[]; itemIds: string[] };
export type BookedLine = { itemId: string; name: string; category: string; quantity: number; unitPriceCents: number | null; needsCrew: boolean; hours?: string | null };
export type RowOverride = { checked?: boolean | null; details?: string | null; feeCents?: number | null };

// Which row an item belongs to: an explicit item mapping first, then a
// category, then a word of its name. Nothing matched: a service goes under
// Miscellaneous, a physical rental under Rental Options.
export function rowForItem(rows: ServiceRowDef[], item: { itemId: string; name: string; category: string; needsCrew: boolean }): ServiceRowDef | null {
  const real = rows.filter((r) => !r.isGroupHeading);
  const byId = real.find((r) => r.itemIds.includes(item.itemId));
  if (byId) return byId;
  const byCategory = real.find((r) => r.categories.some((c) => c.toLowerCase() === item.category.toLowerCase()));
  if (byCategory) return byCategory;
  const name = item.name.toLowerCase();
  const byWord = real.find((r) => r.itemWords.some((w) => w.trim() !== "" && name.includes(w.toLowerCase())));
  if (byWord) return byWord;
  const fallback = item.needsCrew ? FALLBACK_ROW.service : FALLBACK_ROW.rental;
  return real.find((r) => r.label === fallback) ?? null;
}

export type RolledRow = ServiceRowDef & { checked: boolean; details: string | null; feeCents: number | null; items: BookedLine[] };

// Booking lines roll up into their rows: details list what was booked with
// quantities, the fee adds the lines' prices. Staff overrides win.
export function rollUpServices(rows: ServiceRowDef[], lines: BookedLine[], overrides: Record<string, RowOverride> = {}): RolledRow[] {
  const sorted = [...rows].sort((a, b) => (a.column === b.column ? a.position - b.position : a.column === "left" ? -1 : 1));
  const grouped = new Map<string, BookedLine[]>();
  for (const line of lines) {
    const row = rowForItem(sorted, line);
    if (!row) continue;
    grouped.set(row.id, [...(grouped.get(row.id) ?? []), line]);
  }
  return sorted.map((row) => {
    const items = grouped.get(row.id) ?? [];
    const priced = items.filter((l) => l.unitPriceCents !== null);
    const computedFee = items.length > 0 && priced.length > 0 ? priced.reduce((sum, l) => sum + (l.unitPriceCents as number) * l.quantity, 0) : null;
    const computedDetails = items.length > 0 ? items.map((l) => `${l.name}${l.quantity > 1 ? ` x${l.quantity}` : ""}${l.hours ? ` (${l.hours})` : ""}`).join("; ") : null;
    const o = overrides[row.id] ?? {};
    return {
      ...row,
      items,
      checked: o.checked ?? items.length > 0,
      details: o.details !== undefined && o.details !== null ? o.details : computedDetails,
      feeCents: o.feeCents !== undefined && o.feeCents !== null ? o.feeCents : computedFee,
    };
  });
}

// ---- readiness ------------------------------------------------------------------

export type ContractDetails = {
  venueName: string | null;
  onsiteContactName: string | null;
  onsiteContactPhone: string | null;
  expectedGuests: number | null;
  timeFrom: string | null;
  timeTo: string | null;
};

// What has to be filled in before the GO contract can go out, in words.
export function goContractMissing(d: ContractDetails): string[] {
  const missing: string[] = [];
  if (!d.venueName?.trim()) missing.push("the venue name");
  if (!d.onsiteContactName?.trim()) missing.push("the on-site contact's name");
  if (!d.onsiteContactPhone?.trim()) missing.push("the on-site contact's phone");
  if (d.expectedGuests === null || d.expectedGuests === undefined) missing.push("the number of expected guests");
  if (!d.timeFrom?.trim() || !d.timeTo?.trim()) missing.push("the event time, from and to");
  return missing;
}

export function goContractReadinessMessage(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Fill in ${list} under Contract details before sending the GO contract.`;
}

// ---- composing ------------------------------------------------------------------

export type GoCompanyInput = { name: string; addressLine: string; phone: string; email: string; website: string; footerLine: string; logoUrl: string | null };

export type GoComposeInput = {
  terms: GoTermsContent;
  numbers: GoTokenValues;
  company: GoCompanyInput;
  // When the link went out (or will), for the confirm-by date.
  sentAt: Date;
  signAndPayWindowDays: number;
  client: { nameOrg: string; email: string | null; mailingAddress: string | null; city: string | null; state: string | null; zip: string | null; phoneHome: string | null; phoneWork: string | null; phoneCell: string | null };
  event: {
    type: string | null;
    guestOfHonor: string | null;
    date: string; // YYYY-MM-DD
    timeFrom: string | null;
    timeTo: string | null;
    expectedGuests: number | null;
    ageRange: string | null;
    venueName: string | null;
    venueAddress: string | null;
    venuePhone: string | null;
    onsiteContactName: string | null;
    onsiteContactPhone: string | null;
    planner: string | null;
  };
  specialRequests: string | null;
  rows: RolledRow[];
  discount: { percent: number | null; amountCents: number | null; description: string | null };
  signatures: { client: GoSignature | null; additional: GoSignature | null; go: GoSignature | null };
};

const str = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

// "Saturday, October 10, 2026"
export function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// "October 17, 2026"
export function plainDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function composeGoDocument(input: GoComposeInput): GoDocument {
  const fill = (t: string) => fillGoTokens(t, input.numbers);
  const t = input.terms;
  const field = (r: RolledRow): GoField =>
    r.isGroupHeading ? { label: r.label, checked: null, details: null, fee: null, isGroupHeading: true } : { label: r.label, checked: r.checked, details: str(r.details), fee: r.feeCents === null ? null : r.feeCents, isGroupHeading: false };
  const left = input.rows.filter((r) => r.column === "left").map(field);
  const right = input.rows.filter((r) => r.column === "right").map(field);
  const totals = goTotals({
    feesCents: input.rows.filter((r) => !r.isGroupHeading && r.checked && r.feeCents !== null).map((r) => r.feeCents as number),
    discountPercent: input.discount.percent,
    discountAmountCents: input.discount.amountCents,
    retainerPercent: input.numbers.retainerPercent,
  });
  const confirmBy = new Date(input.sentAt.getTime() + input.signAndPayWindowDays * 86_400_000);
  const timeFromTo = input.event.timeFrom && input.event.timeTo ? `${input.event.timeFrom} / ${input.event.timeTo}` : str(input.event.timeFrom) ?? str(input.event.timeTo);
  return {
    header: {
      title: t.header.title,
      confirmByLine: t.header.confirmByLine,
      confirmByDate: plainDay(confirmBy.toISOString().slice(0, 10)),
      nonRefundableLine: t.header.nonRefundableLine,
    },
    company: {
      name: str(input.company.name),
      addressLine: str(input.company.addressLine),
      phone: str(input.company.phone),
      email: str(input.company.email),
      website: str(input.company.website),
      logoUrl: str(input.company.logoUrl),
      footerLine: str(input.company.footerLine),
    },
    client: {
      nameOrg: str(input.client.nameOrg),
      email: str(input.client.email),
      mailingAddress: str(input.client.mailingAddress),
      city: str(input.client.city),
      state: str(input.client.state),
      zip: str(input.client.zip),
      phoneHome: str(input.client.phoneHome),
      phoneWork: str(input.client.phoneWork),
      phoneCell: str(input.client.phoneCell),
    },
    event: {
      type: str(input.event.type),
      guestOfHonor: str(input.event.guestOfHonor),
      date: longDay(input.event.date),
      timeFromTo,
      expectedGuests: input.event.expectedGuests === null ? null : String(input.event.expectedGuests),
      ageRange: str(input.event.ageRange),
      venueName: str(input.event.venueName),
      venueAddress: str(input.event.venueAddress),
      venuePhone: str(input.event.venuePhone),
      onsiteContactName: str(input.event.onsiteContactName),
      onsiteContactPhone: str(input.event.onsiteContactPhone),
      planner: str(input.event.planner),
    },
    specialRequests: str(input.specialRequests),
    services: { left, right, note: fill(t.servicesNote) },
    payment: {
      subtotal: totals.subtotal,
      discountPercent: input.discount.percent,
      discountAmount: input.discount.amountCents,
      totalDiscount: totals.totalDiscount,
      discountDescription: str(input.discount.description),
      total: totals.total,
      retainerPercent: input.numbers.retainerPercent,
      retainerAmount: totals.retainer,
      balance: totals.balance,
      balanceDueDays: input.numbers.balanceDueDays,
      balanceDueDate: plainDay(daysBefore(input.event.date, input.numbers.balanceDueDays)),
      note: fill(t.paymentNote),
    },
    terms: {
      heading: t.terms.heading,
      pageHeader: t.terms.pageHeader,
      pageSubheader: t.terms.pageSubheader,
      clauses: t.terms.clauses.map((c, i) => ({ number: i + 1, title: c.title, body: fill(c.body) })),
    },
    acceptance: {
      heading: t.acceptance.heading,
      text: fill(t.acceptance.text),
      esignLabel: t.acceptance.esignLabel,
      confirmLine: t.acceptance.confirmLine,
      nonRefundableLine: t.acceptance.nonRefundableLine,
    },
    signatures: {
      client: input.signatures.client,
      additional: input.signatures.additional,
      go: input.signatures.go,
    },
  };
}

// The hash the customer signs: the whole document, GO's signature included.
export function goDocumentHash(doc: GoDocument): string {
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex");
}

// ---- the document as text ---------------------------------------------------------

// The layout labels the form carries (the storefront draws them from its own
// code; the PDF and this text draw them from here). Kept in one list so the
// three agree.
export const GO_LABELS = {
  client: ["INDIVIDUAL NAME AND ORGANIZATION", "EMAIL ADDRESS", "MAILING ADDRESS", "CITY", "STATE", "ZIP", "PHONE - HOME", "PHONE - WORK", "PHONE - CELL"],
  event: ["TYPE OF EVENT", "GUEST OF HONOR", "DAY / DATE OF EVENT", "TIME (FROM / TO)", "NUMBER OF EXPECTED GUESTS", "AGE RANGE", "VENUE NAME", "VENUE ADDRESS", "VENUE PHONE #", "ON-SITE CONTACT NAME", "ON-SITE CONTACT PHONE #", "PLANNER / COORDINATOR (IF NOT GO EVENT GROUP)"],
  sections: { client: "CLIENT INFORMATION", event: "EVENT DETAILS", special: "SPECIAL REQUESTS, MISCELLANEOUS OR INFORMATION", services: "SERVICES SELECTED", servicesSub: "(check each service included; add details / quantity / hours and the fee)", payment: "PAYMENT SUMMARY" },
  serviceColumns: ["DETAILS / QTY / HOURS", "FEE ($)"],
  payment: ["SERVICES SUBTOTAL (AUTO)", "DISCOUNT (%)", "DISCOUNT ($)", "TOTAL DISCOUNT (AUTO)", "DISCOUNT DESCRIPTION / CODE", "TOTAL CONTRACTED AMOUNT (AUTO)"],
  retainerLabel: (pct: number | null) => `RETAINER DUE AT SIGNING${pct !== null ? ` - ${pct}%` : ""} (AUTO)`,
  balanceLabel: (days: number | null) => `BALANCE DUE${days !== null ? ` ${days} DAYS PRIOR` : ""} (AUTO)`,
  signers: [
    { who: "CLIENT", auto: true },
    { who: "ADDITIONAL SIGNER", auto: true },
    { who: "GO EVENT GROUP REPRESENTATIVE", auto: false },
  ],
  signatureCols: (who: string, auto: boolean) => [`${who} - PRINTED NAME`, `${who} - SIGNATURE${auto ? " (AUTO FROM NAME)" : ""}`, "DATE"],
  pageOf: (n: number, of: number) => `Page ${n} of ${of}`,
};

// The reference breaks its terms across two pages: clauses 1 to 13 on page 2,
// the rest with the acceptance block on page 3. The PDF does the same.
export const CLAUSES_ON_PAGE_2 = 13;

// The document in reading order, one line per thing the paper says, with the
// form's labels and the three page footers. Values are left out when empty
// (a blank form). This is what the verbatim test compares to the reference.
export function renderGoText(doc: GoDocument, clausesOnPage2 = CLAUSES_ON_PAGE_2): string {
  const L = GO_LABELS;
  const out: string[] = [];
  const line = (s: string | null | undefined) => {
    if (s && s.trim() !== "") out.push(s.trim());
  };
  const foot = (n: number) => {
    line(doc.company.footerLine);
    line(L.pageOf(n, 3));
  };
  line(doc.header.title);
  line(doc.header.confirmByLine);
  line(doc.header.confirmByDate);
  line(doc.header.nonRefundableLine);
  line(doc.company.name);
  line(doc.company.website);
  line([doc.company.addressLine, doc.company.phone ? `Phone: ${doc.company.phone}` : null, doc.company.email].filter(Boolean).join(" | "));
  line(L.sections.client);
  const client = [doc.client.nameOrg, doc.client.email, doc.client.mailingAddress, doc.client.city, doc.client.state, doc.client.zip, doc.client.phoneHome, doc.client.phoneWork, doc.client.phoneCell];
  L.client.forEach((label, i) => {
    line(label);
    line(client[i]);
  });
  line(L.sections.event);
  const ev = doc.event;
  const event = [ev.type, ev.guestOfHonor, ev.date, ev.timeFromTo, ev.expectedGuests, ev.ageRange, ev.venueName, ev.venueAddress, ev.venuePhone, ev.onsiteContactName, ev.onsiteContactPhone, ev.planner];
  L.event.forEach((label, i) => {
    line(label);
    line(event[i]);
  });
  line(L.sections.special);
  line(doc.specialRequests);
  line(`${L.sections.services} ${L.sections.servicesSub}`);
  for (const col of [doc.services.left, doc.services.right]) {
    line(L.serviceColumns.join(" "));
    for (const f of col) {
      line([f.label, f.details, typeof f.fee === "number" ? `$${(f.fee / 100).toFixed(2)}` : f.fee === "-" ? "-" : null].filter(Boolean).join(" "));
    }
  }
  line(doc.services.note);
  line(L.sections.payment);
  const money = (c: Cents) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : c === "-" ? "-" : null);
  const pay = doc.payment;
  const payValues = [money(pay.subtotal), pay.discountPercent === null ? null : `${pay.discountPercent}%`, money(pay.discountAmount), money(pay.totalDiscount), pay.discountDescription, money(pay.total)];
  L.payment.forEach((label, i) => {
    line(label);
    line(payValues[i]);
  });
  line(L.retainerLabel(pay.retainerPercent));
  line(money(pay.retainerAmount));
  line(L.balanceLabel(pay.balanceDueDays));
  line(money(pay.balance));
  line(pay.note);
  foot(1);
  line(doc.terms.pageHeader);
  line(doc.terms.pageSubheader);
  line(doc.terms.heading);
  const clause = (c: GoDocument["terms"]["clauses"][number]) => line(`${c.number}. ${c.title}. ${c.body}`);
  doc.terms.clauses.slice(0, clausesOnPage2).forEach(clause);
  foot(2);
  line(doc.terms.pageHeader);
  line(doc.terms.pageSubheader);
  doc.terms.clauses.slice(clausesOnPage2).forEach(clause);
  line(doc.acceptance.heading);
  line(doc.acceptance.text);
  line(doc.acceptance.esignLabel);
  const sigs = [doc.signatures.client, doc.signatures.additional, doc.signatures.go];
  L.signers.forEach((s, i) => {
    line(L.signatureCols(s.who, s.auto).join(" "));
    line(sigs[i]?.printedName);
  });
  line(doc.acceptance.confirmLine);
  line(doc.acceptance.nonRefundableLine);
  foot(3);
  return out.join("\n");
}

// Blank-form rendering with no booking at all: what the template says on its
// own, the way the reference reads. The verbatim test and the admin's live
// preview use it.
export function blankGoDocument(terms: GoTermsContent, numbers: GoTokenValues, company: GoCompanyInput, rows: ServiceRowDef[]): GoDocument {
  const doc = composeGoDocument({
    terms,
    numbers,
    company,
    sentAt: new Date(0),
    signAndPayWindowDays: 0,
    client: { nameOrg: "", email: null, mailingAddress: null, city: null, state: null, zip: null, phoneHome: null, phoneWork: null, phoneCell: null },
    event: { type: null, guestOfHonor: null, date: "1970-01-01", timeFrom: null, timeTo: null, expectedGuests: null, ageRange: null, venueName: null, venueAddress: null, venuePhone: null, onsiteContactName: null, onsiteContactPhone: null, planner: null },
    specialRequests: null,
    rows: rollUpServices(rows, []).map((r) => ({ ...r, checked: false, details: null, feeCents: null })),
    discount: { percent: null, amountCents: null, description: null },
    signatures: { client: null, additional: null, go: null },
  });
  // A blank form shows no dates and no zero amounts.
  doc.header.confirmByDate = null;
  doc.event.date = null;
  doc.payment = { ...doc.payment, subtotal: null, discountAmount: null, totalDiscount: null, total: null, retainerAmount: null, balance: null, balanceDueDate: null };
  return doc;
}

export const seededRows = (seed: { column: "left" | "right"; label: string; isGroupHeading?: boolean; categories?: string[]; itemWords?: string[] }[]): ServiceRowDef[] =>
  seed.map((s, i) => ({ id: `seed-${i}`, column: s.column, position: i, label: s.label, isGroupHeading: s.isGroupHeading === true, categories: s.categories ?? [], itemWords: s.itemWords ?? [], itemIds: [] }));

export { roundHalfUp, toCents };
