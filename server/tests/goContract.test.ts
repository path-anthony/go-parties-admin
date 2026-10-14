// Pure tests for the GO contract: the template reads exactly as the reference
// at the reference's numbers, the money math rounds the way the form says, the
// booking's items roll up into the right service rows, the required fields
// are named in plain English, and the document carries nothing internal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blankGoDocument, composeGoDocument, fillGoTokens, goContractMissing, goContractReadinessMessage, goDocumentHash, renderGoText, rollUpServices, rowForItem, seededRows, type BookedLine } from "../contract/goDocument.js";
import { daysBefore, goTotals, roundHalfUp, toCents, wholeDollars } from "../contract/goMoney.js";
import { GO_TEMPLATE_V1, REFERENCE_COMPANY, REFERENCE_NUMBERS, SERVICE_ROWS_SEED } from "../contract/goTemplate.js";

const here = new URL(".", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, here), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const rows = seededRows(SERVICE_ROWS_SEED);
const company = { ...REFERENCE_COMPANY, logoUrl: null };

test("at the reference's numbers the template reads character for character as the reference", () => {
  const doc = blankGoDocument(GO_TEMPLATE_V1, REFERENCE_NUMBERS, company, rows);
  const rendered = renderGoText(doc);
  const expected = fixture("go-contract-blank.reading-order.txt");
  assert.equal(collapse(rendered), collapse(expected));
  // And the fixture itself is nothing but the reference PDF's own words: every
  // line of it is in the text extracted from the PDF (the services note is
  // split by a column in the extraction, so it is checked in its two halves).
  const extracted = collapse(fixture("go-contract-blank.layout.txt"));
  for (const line of expected.split("\n").map(collapse).filter(Boolean)) {
    if (line.startsWith("Light-up platforms")) {
      const [a, b] = line.split("custom ");
      assert.ok(extracted.includes(a + "custom") && extracted.includes(b), "services note");
      continue;
    }
    assert.ok(extracted.includes(line), `not in the reference: ${line.slice(0, 80)}`);
  }
  assert.doesNotMatch(rendered, /\{\{/, "no token left unfilled");
});

test("changing a business number changes every place the contract says it", () => {
  const doc = blankGoDocument(GO_TEMPLATE_V1, { ...REFERENCE_NUMBERS, retainerPercent: 20, lateCancellationDays: 5, returnedCheckFee: 35.5 }, company, rows);
  const text = renderGoText(doc);
  assert.match(text, /retainer equal to 20% of the Total/);
  assert.match(text, /RETAINER DUE AT SIGNING - 20% \(AUTO\)/);
  assert.match(text, /retainer \(20% of the Total Contracted Amount\)/);
  assert.match(text, /within 5 days of the contracted date/);
  assert.match(text, /\$35\.50 return fee/);
  assert.doesNotMatch(text, /30% of the Total/);
  assert.equal(fillGoTokens("{{nope}} {{retainerPercent}}", REFERENCE_NUMBERS), "{{nope}} 30");
});

test("money: cents, half-up rounding, and the form's own formulas", () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(2.4999), 2);
  assert.equal(toCents(19.995), 2000);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(wholeDollars(50), "$50");
  assert.equal(wholeDollars(50.5), "$50.50");
  assert.equal(wholeDollars(1250), "$1,250");
  // $3,333.33 subtotal, 10% + $5 off, 30% retainer.
  const t = goTotals({ feesCents: [333333], discountPercent: 10, discountAmountCents: 500, retainerPercent: 30 });
  assert.deepEqual(t, { subtotal: 333333, totalDiscount: 33833, total: 299500, retainer: 89850, balance: 209650 });
  // Half a cent rounds up on the discount and on the retainer.
  const h = goTotals({ feesCents: [10005], discountPercent: 50, discountAmountCents: null, retainerPercent: 30 });
  assert.deepEqual([h.totalDiscount, h.total, h.retainer, h.balance], [5003, 5002, 1501, 3501]);
  // A discount can never take the total below zero.
  assert.equal(goTotals({ feesCents: [1000], discountPercent: null, discountAmountCents: 5000, retainerPercent: 30 }).total, 0);
  assert.equal(goTotals({ feesCents: [], discountPercent: 10, discountAmountCents: null, retainerPercent: 30 }).subtotal, 0);
  assert.equal(daysBefore("2026-11-05", 30), "2026-10-06");
  assert.equal(daysBefore("2026-03-01", 1), "2026-02-28");
});

const line = (over: Partial<BookedLine>): BookedLine => ({ itemId: "i", name: "x", category: "Games", quantity: 1, unitPriceCents: 10000, needsCrew: false, ...over });

test("booked items roll up into their service rows; unmapped ones land in Miscellaneous or Rental Options", () => {
  assert.equal(rowForItem(rows, line({ name: "MC and DJ: Basic (4 hrs)", category: "Entertainment", needsCrew: true }))?.label, "Go DJ");
  assert.equal(rowForItem(rows, line({ name: "Photography: Essential (8 hrs)", category: "Photo and Video", needsCrew: true }))?.label, "Go Photo");
  assert.equal(rowForItem(rows, line({ name: "Magic Mirror Booth (with attendant)", category: "Photo and Video", needsCrew: true }))?.label, "Go Photo Booth");
  assert.equal(rowForItem(rows, line({ name: "Day of Planner (full day)", category: "Planning Services", needsCrew: true }))?.label, "Event Coordination");
  assert.equal(rowForItem(rows, line({ name: "Castle Bounce", category: "Inflatables" }))?.label, "Inflatables");
  assert.equal(rowForItem(rows, line({ name: "Cold Sparks", category: "Production and Effects" }))?.label, "Cold Spark Fountains");
  assert.equal(rowForItem(rows, line({ name: "Dance on the Clouds (Dry Ice)", category: "Production and Effects" }))?.label, "Dancing on Clouds");
  assert.equal(rowForItem(rows, line({ name: "Pro Audio / Sound System and Music", category: "Production and Effects" }))?.label, "Sound System");
  assert.equal(rowForItem(rows, line({ name: "Giant Jenga", category: "Games" }))?.label, "Rental Options", "a physical item nobody claims");
  assert.equal(rowForItem(rows, line({ name: "Hypnotists", category: "Entertainment", needsCrew: true }))?.label, "Miscellaneous", "a service nobody claims");
  // An explicit item mapping beats the category and the name.
  const custom = rows.map((r) => (r.label === "Uplighting" ? { ...r, itemIds: ["special"] } : r));
  assert.equal(rowForItem(custom, line({ itemId: "special", name: "Castle Bounce", category: "Inflatables" }))?.label, "Uplighting");

  const rolled = rollUpServices(rows, [
    line({ itemId: "dj", name: "MC and DJ: Basic (4 hrs)", category: "Entertainment", needsCrew: true, unitPriceCents: 120000 }),
    line({ itemId: "dj2", name: "DJ Additional Hours", category: "Entertainment", needsCrew: true, unitPriceCents: 15000, quantity: 2 }),
    line({ itemId: "b1", name: "Castle Bounce", category: "Inflatables", unitPriceCents: 25000, quantity: 2 }),
    line({ itemId: "t1", name: "Giant Jenga", category: "Games", unitPriceCents: null }),
  ]);
  const by = (label: string) => rolled.find((r) => r.label === label)!;
  assert.deepEqual([by("Go DJ").checked, by("Go DJ").details, by("Go DJ").feeCents], [true, "MC and DJ: Basic (4 hrs); DJ Additional Hours x2", 150000]);
  assert.deepEqual([by("Inflatables").checked, by("Inflatables").details, by("Inflatables").feeCents], [true, "Castle Bounce x2", 50000]);
  assert.deepEqual([by("Rental Options").checked, by("Rental Options").details, by("Rental Options").feeCents], [true, "Giant Jenga", null], "an unpriced item is listed with no fee");
  assert.deepEqual([by("Go Photo").checked, by("Go Photo").details, by("Go Photo").feeCents], [false, null, null]);
  assert.ok(rolled.find((r) => r.isGroupHeading));
  // Staff overrides win, including unchecking a row that has items.
  const over = rollUpServices(rows, [line({ itemId: "dj", name: "MC and DJ: Basic (4 hrs)", category: "Entertainment", needsCrew: true, unitPriceCents: 120000 })], {
    [by("Go DJ").id]: { checked: false, details: "6 hrs, two DJs", feeCents: 99900 },
    [by("Uplighting").id]: { checked: true, feeCents: 30000 },
  });
  const dj = over.find((r) => r.label === "Go DJ")!;
  assert.deepEqual([dj.checked, dj.details, dj.feeCents], [false, "6 hrs, two DJs", 99900]);
  assert.deepEqual([over.find((r) => r.label === "Uplighting")!.checked, over.find((r) => r.label === "Uplighting")!.feeCents], [true, 30000]);
});

test("the required contract details are named in plain English", () => {
  const full = { venueName: "The Barn", onsiteContactName: "Pat", onsiteContactPhone: "860", expectedGuests: 80, timeFrom: "2 PM", timeTo: "6 PM" };
  assert.deepEqual(goContractMissing(full), []);
  assert.equal(goContractReadinessMessage([]), null);
  const missing = goContractMissing({ ...full, venueName: " ", expectedGuests: null, timeTo: null });
  assert.deepEqual(missing, ["the venue name", "the number of expected guests", "the event time, from and to"]);
  assert.equal(goContractReadinessMessage(missing), "Fill in the venue name, the number of expected guests and the event time, from and to under Contract details before sending the GO contract.");
  assert.equal(goContractReadinessMessage(["the venue name"]), "Fill in the venue name under Contract details before sending the GO contract.");
});

test("the document is the client's own data and nothing internal; the hash covers all of it", () => {
  const rolled = rollUpServices(rows, [line({ itemId: "dj", name: "MC and DJ: Basic (4 hrs)", category: "Entertainment", needsCrew: true, unitPriceCents: 120000 })]);
  const base = {
    terms: GO_TEMPLATE_V1,
    numbers: REFERENCE_NUMBERS,
    company: { ...company, logoUrl: "https://api.test/api/contracts/logo.png" },
    sentAt: new Date("2026-10-14T15:00:00Z"),
    signAndPayWindowDays: 7,
    client: { nameOrg: "Pat Smith", email: "pat@example.com", mailingAddress: "1 Main St", city: "Avon", state: "CT", zip: "06001", phoneHome: null, phoneWork: null, phoneCell: "(860) 555-0100" },
    event: { type: "Sweet 16", guestOfHonor: "Sam", date: "2026-11-21", timeFrom: "2 PM", timeTo: "6 PM", expectedGuests: 80, ageRange: "teens", venueName: "The Barn", venueAddress: "2 Farm Rd", venuePhone: "860", onsiteContactName: "Pat", onsiteContactPhone: "860", planner: null },
    specialRequests: "No fog",
    rows: rolled,
    discount: { percent: 10, amountCents: 0, description: "Fall" },
    signatures: { client: null, additional: null, go: { printedName: "Andy Caron", signedAt: "2026-10-14T15:00:00Z" } },
  };
  const doc = composeGoDocument(base);
  assert.equal(doc.header.confirmByDate, "October 21, 2026");
  assert.equal(doc.event.date, "Saturday, November 21, 2026");
  assert.equal(doc.event.timeFromTo, "2 PM / 6 PM");
  assert.equal(doc.event.expectedGuests, "80");
  assert.deepEqual([doc.payment.subtotal, doc.payment.totalDiscount, doc.payment.total, doc.payment.retainerAmount, doc.payment.balance], [120000, 12000, 108000, 32400, 75600]);
  assert.equal(doc.payment.balanceDueDate, "October 22, 2026");
  assert.equal(doc.terms.clauses.length, 16);
  assert.equal(doc.terms.clauses[0].number, 1);
  assert.equal(doc.signatures.go?.printedName, "Andy Caron");
  // Locked top-level shape, nothing more.
  assert.deepEqual(Object.keys(doc), ["header", "company", "client", "event", "specialRequests", "services", "payment", "terms", "acceptance", "signatures"]);
  const json = JSON.stringify(doc);
  for (const secret of ["itemId", "accountId", "bookingId", "notes", "\"id\"", "seed-"]) assert.ok(!json.includes(secret), secret);
  // Any change, GO's signature included, changes the hash.
  const h1 = goDocumentHash(doc);
  assert.equal(h1, goDocumentHash(composeGoDocument(base)));
  assert.notEqual(h1, goDocumentHash(composeGoDocument({ ...base, signatures: { ...base.signatures, go: null } })));
  assert.notEqual(h1, goDocumentHash(composeGoDocument({ ...base, discount: { ...base.discount, percent: 11 } })));
});
