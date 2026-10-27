// Block T1, the pure parts: the tier rules, the quote cart spelling and
// expiry, the money math, the webhook signature check, the address judgement,
// the portal's stage and steps, and the contract-ready link choice. Nothing
// here touches a database or the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTier, tier1Amount } from "../tiers.js";
import { normalizeCart, quoteExpiry } from "../quotes.js";
import { amountsFor, dueFor } from "../payments.js";
import { formEncode, signWebhookPayload, verifyWebhookSignature } from "../stripe/client.js";
import { judgeDelivery, mapsUrl, parseDelivery, type Delivery, type FoundPlace } from "../delivery.js";
import { customerContract, customerStage, customerSteps, type PortalBooking } from "../portal.js";
import { contractReadyLink } from "../notify.js";
import { retainerOverdue } from "../routes/bookings.js";
import { easternDay } from "../automation/time.js";

const rules = { fullReviewThreshold: 15000, reviewOccasions: ["Wedding"], contractRequiredOver: 1000, contractRequiredForCrewed: true };

test("tier rules: review first, then contract, else the rental policy", () => {
  assert.deepEqual(decideTier({ total: 500, occasions: [], categories: [], crewed: false }, rules), { tier: 1, reasons: [] });
  assert.deepEqual(decideTier({ total: 1000, occasions: [], categories: [], crewed: false }, rules).tier, 1, "exactly the threshold is not over it");
  assert.deepEqual(decideTier({ total: 1000.01, occasions: [], categories: [], crewed: false }, rules), { tier: 2, reasons: ["over-contract-threshold"] });
  assert.deepEqual(decideTier({ total: 300, occasions: [], categories: [], crewed: true }, rules), { tier: 2, reasons: ["crewed"] });
  assert.equal(decideTier({ total: 300, occasions: [], categories: [], crewed: true }, { ...rules, contractRequiredForCrewed: false }).tier, 1);
  assert.deepEqual(decideTier({ total: 20000, occasions: [], categories: [], crewed: true }, rules), { tier: 3, reasons: ["threshold"] });
  assert.deepEqual(decideTier({ total: 300, occasions: ["Wedding"], categories: [], crewed: false }, rules), { tier: 3, reasons: ["occasion"] });
  assert.equal(decideTier({ total: null, occasions: [], categories: [], crewed: false }, rules).tier, 1, "no price means nothing to compare");
});

test("tier 1 collects the retainer percent or the full amount, to the cent", () => {
  assert.equal(tier1Amount(1499, 30, "retainer"), 449.7);
  assert.equal(tier1Amount(1499, 30, "full"), 1499);
  assert.equal(tier1Amount(33.33, 20, "retainer"), 6.67);
});

test("a cart normalizes to one spelling whatever the order", () => {
  const a = normalizeCart({ itemIds: ["b", "a", "a"], packageId: null, addons: { b: ["y", "x"], a: ["z"] }, eventDate: "2026-12-01", eventTime: " 2 PM ", occasion: "Sweet 16" });
  const b = normalizeCart({ itemIds: ["a", "b"], packageId: "", addons: { a: ["z"], b: ["x", "y", "y"] }, eventDate: "2026-12-01", eventTime: "2 PM", occasion: "Sweet 16" });
  assert.deepEqual(a, b);
  assert.deepEqual(a.itemIds, ["a", "b"]);
  assert.equal(normalizeCart({ itemIds: ["a"], packageId: null, addons: {}, eventDate: "2026-12-01", eventTime: null, occasion: null }).addons, null);
});

test("a quote expires at the end of the day it was made, Eastern", () => {
  const made = new Date("2026-11-03T15:00:00-05:00");
  const exp = quoteExpiry(made);
  assert.equal(easternDay(exp), "2026-11-03");
  assert.equal(easternDay(new Date(exp.getTime() + 2000)), "2026-11-04");
  // Just before midnight Eastern still expires that same day.
  const late = new Date("2026-11-03T23:50:00-05:00");
  assert.equal(easternDay(quoteExpiry(late)), "2026-11-03");
});

const settings = { depositPercentage: 20, tier1Collect: "retainer" };

test("amounts come from the booking and the signed contract, never a browser", () => {
  const t1 = amountsFor({ tier: 1, total: "700", retainerPaid: false, balancePaid: false }, [], settings);
  assert.deepEqual(t1, { totalCents: 70000, retainerDueCents: 14000, retainerPaidCents: 0, paidCents: 0, balanceDueCents: 56000, retainerPaid: false, balancePaid: false });
  const full = amountsFor({ tier: 1, total: "700", retainerPaid: false, balancePaid: false }, [], { ...settings, tier1Collect: "full" });
  assert.equal(full.retainerDueCents, 70000);
  const doc = { payment: { total: 333000, retainerAmount: 99900 } };
  const t2 = amountsFor({ tier: 2, total: "3000", retainerPaid: false, balancePaid: false, agreement: { contractDocument: { documentJson: doc } } }, [{ kind: "retainer", status: "succeeded", amountCents: 99900, refundedCents: 0 }], settings);
  assert.equal(t2.totalCents, 333000, "the contract total wins over the quoted total");
  assert.equal(t2.retainerDueCents, 99900);
  assert.equal(t2.retainerPaid, true);
  assert.equal(t2.balanceDueCents, 333000 - 99900);
  const refunded = amountsFor({ tier: 2, total: "3000", retainerPaid: false, balancePaid: false, agreement: { contractDocument: { documentJson: doc } } }, [{ kind: "retainer", status: "refunded", amountCents: 99900, refundedCents: 99900 }], settings);
  assert.equal(refunded.retainerPaid, false, "a refunded retainer is no longer paid");
  assert.equal(amountsFor({ tier: 1, total: null, retainerPaid: false, balancePaid: false }, [], settings).retainerDueCents, null);
});

test("what can be collected now: nothing-due and not-payable", () => {
  const money = amountsFor({ tier: 2, total: "3000", retainerPaid: false, balancePaid: false, agreement: { contractDocument: { documentJson: { payment: { total: 300000, retainerAmount: 60000 } } } } }, [], settings);
  assert.deepEqual(dueFor({ status: "Held", tier: 2, agreement: { contractStatus: "Sent" } }, money, "retainer"), { reason: "not-payable", message: "Sign the contract first, then the retainer." });
  assert.deepEqual(dueFor({ status: "Signed", tier: 2, agreement: { contractStatus: "Signed" } }, money, "retainer"), { cents: 60000 });
  assert.equal((dueFor({ status: "Signed", tier: 2, agreement: { contractStatus: "Signed" } }, money, "balance") as { reason: string }).reason, "not-payable", "balance waits for the retainer");
  assert.equal((dueFor({ status: "Cancelled", tier: 1, agreement: null }, money, "retainer") as { reason: string }).reason, "not-payable");
  const paid = { ...money, retainerPaid: true, retainerPaidCents: 60000, paidCents: 60000, balanceDueCents: 240000 };
  assert.equal((dueFor({ status: "Signed", tier: 2, agreement: { contractStatus: "Signed" } }, paid, "retainer") as { reason: string }).reason, "nothing-due");
  assert.deepEqual(dueFor({ status: "Signed", tier: 2, agreement: { contractStatus: "Signed" } }, paid, "balance"), { cents: 240000 });
});

test("webhook signatures: right, wrong, stale, missing", () => {
  const secret = "whsec_test_zz";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
  const now = new Date("2026-11-03T15:00:00Z");
  assert.deepEqual(verifyWebhookSignature(body, signWebhookPayload(body, secret, now), secret, now), { ok: true });
  assert.equal(verifyWebhookSignature(body, signWebhookPayload(body, "whsec_other", now), secret, now).ok, false);
  assert.equal(verifyWebhookSignature(body + " ", signWebhookPayload(body, secret, now), secret, now).ok, false, "a changed body fails");
  assert.equal(verifyWebhookSignature(body, signWebhookPayload(body, secret, new Date(now.getTime() - 10 * 60_000)), secret, now).ok, false, "ten minutes old is too old");
  assert.equal(verifyWebhookSignature(body, undefined, secret, now).ok, false);
  assert.equal(verifyWebhookSignature(body, "t=abc,v1=zz", secret, now).ok, false);
});

test("Stripe form bodies use bracketed keys", () => {
  const parts = formEncode({ ui_mode: "embedded", line_items: [{ quantity: 1, price_data: { unit_amount: 500, product_data: { name: "Retainer" } } }], metadata: { bookingId: "b1" } });
  assert.ok(parts.includes("ui_mode=embedded"));
  assert.ok(parts.includes(`${encodeURIComponent("line_items[0][price_data][unit_amount]")}=500`));
  assert.ok(parts.includes(`${encodeURIComponent("metadata[bookingId]")}=b1`));
});

const sent: Delivery = {
  placeId: "ChIJtest",
  formattedAddress: "14 Maple Ln, Avon, CT 06001, USA",
  components: { streetNumber: "14", route: "Maple Lane", city: "Avon", state: "CT", zip: "06001" },
  addressLat: 41.8102,
  addressLng: -72.8309,
  setupLat: 41.8103,
  setupLng: -72.8308,
  setupNotes: "Backyard",
};
const found = (over: Partial<FoundPlace> = {}): FoundPlace => ({
  id: "ChIJtest",
  formattedAddress: "14 Maple Ln, Avon, CT 06001, USA",
  location: { lat: 41.8102, lng: -72.8309 },
  components: [
    { types: ["street_number"], longText: "14", shortText: "14" },
    { types: ["route"], longText: "Maple Lane", shortText: "Maple Ln" },
    { types: ["locality"], longText: "Avon", shortText: "Avon" },
    { types: ["postal_code"], longText: "06001", shortText: "06001" },
  ],
  ...over,
});

test("address judgement: valid, city only, mismatch, far away, missing", () => {
  assert.deepEqual(judgeDelivery(sent, found()), { check: "verified", reason: null });
  const cityOnly = judgeDelivery(sent, found({ components: [{ types: ["locality"], longText: "Avon", shortText: "Avon" }] }));
  assert.equal(cityOnly.check, "needs_check");
  assert.match(cityOnly.reason ?? "", /without a street number/);
  const mismatch = judgeDelivery(sent, found({ components: [{ types: ["street_number"], longText: "15", shortText: "15" }, { types: ["route"], longText: "Maple Lane", shortText: "Maple Ln" }] }));
  assert.equal(mismatch.check, "needs_check");
  assert.match(mismatch.reason ?? "", /Google has 15 Maple Lane/);
  const far = judgeDelivery(sent, found({ location: { lat: 41.9, lng: -72.8309 } }));
  assert.equal(far.check, "needs_check");
  assert.match(far.reason ?? "", /m from where Google puts/);
  assert.equal(judgeDelivery(sent, null).check, "needs_check");
  const worded = judgeDelivery(sent, found({ formattedAddress: "14 Maple Lane, Avon, Connecticut 06001" }));
  assert.equal(worded.check, "verified", "same number, street, ZIP and point with different wording is still verified");
});

test("the delivery object is checked for shape and cleaned", () => {
  const ok = parseDelivery({ ...sent, setupNotes: "Gate on the <left> http://x.y" });
  assert.ok(ok && !("invalid" in ok));
  assert.equal((ok as Delivery).setupNotes.includes("http"), false, "links are stripped from notes");
  assert.equal(parseDelivery(null), null);
  assert.equal(parseDelivery(undefined), null);
  assert.deepEqual(parseDelivery({ ...sent, components: { ...sent.components, streetNumber: "" } }), { invalid: "delivery must be a full street address (street number and street)" });
  assert.ok("invalid" in (parseDelivery({ ...sent, addressLat: 200 }) as object));
  assert.equal(mapsUrl(41.81021, -72.83091), "https://www.google.com/maps/search/?api=1&query=41.810210,-72.830910");
  assert.equal(mapsUrl(null, 1), null);
});

const portal = (over: Partial<PortalBooking>): PortalBooking => ({
  status: "Held",
  tier: 1,
  total: "700",
  retainerPaid: false,
  balancePaid: false,
  eventDate: new Date("2026-12-20T00:00:00Z"),
  agreement: null,
  payments: [],
  placeId: null,
  address: null,
  setupLat: null,
  setupLng: null,
  setupNotes: null,
  addressCheck: null,
  ...over,
});

test("the customer's stage: Requested for an unpaid tier 2, the real stages otherwise", () => {
  assert.equal(customerStage(portal({ tier: 2, status: "Signed" })), "Requested");
  assert.equal(customerStage(portal({ tier: 2, status: "Held" })), "Requested");
  assert.equal(customerStage(portal({ tier: 2, status: "Signed", retainerPaid: true })), "Confirmed");
  assert.equal(customerStage(portal({ tier: 1, status: "Held" })), "Held");
  assert.equal(customerStage(portal({ tier: 1, status: "Held", retainerPaid: true })), "Retainer Paid");
  assert.equal(customerStage(portal({ tier: 2, status: "Released" })), "Released");
  assert.equal(customerStage(portal({ tier: 2, status: "Cancelled" })), "Cancelled");
});

test("the customer's steps follow the tier and the money", () => {
  const t1 = customerSteps(portal({}), amountsFor(portal({}), [], settings));
  assert.deepEqual(t1.map((s) => [s.key, s.state]), [["retainer", "next"], ["balance", "waiting"]]);
  const signedDoc = { contractDocument: { signedAt: new Date("2026-11-01T10:00:00Z"), documentJson: { payment: { total: 300000, retainerAmount: 60000 } } } };
  const t2 = portal({ tier: 2, status: "Signed", agreement: { id: "a", format: "go-v2", signingToken: "t", contractStatus: "Signed", contractSentAt: new Date(), contractUrl: "https://x/pdf", ...signedDoc } });
  assert.deepEqual(customerSteps(t2, amountsFor(t2, [], settings)).map((s) => [s.key, s.state]), [["sign", "done"], ["retainer", "next"], ["balance", "waiting"]]);
  const unsigned = portal({ tier: 2, status: "Held", agreement: { id: "a", format: "go-v2", signingToken: "t", contractStatus: "Sent", contractSentAt: new Date(), contractUrl: null, contractDocument: null } });
  assert.deepEqual(customerSteps(unsigned, amountsFor(unsigned, [], settings)).map((s) => [s.key, s.state]), [["sign", "next"], ["retainer", "blocked"], ["balance", "waiting"]]);
  assert.deepEqual(customerSteps(portal({ status: "Released" }), amountsFor(portal({}), [], settings)), []);
  assert.deepEqual(customerContract(portal({})), null, "a rental has no contract");
  assert.equal(customerContract(t2)?.status, "signed");
  assert.equal(customerContract(unsigned)?.status, "sent");
});

test("the contract-ready link goes to the portal for an account, the token page otherwise", () => {
  assert.equal(contractReadyLink({ bookingId: "bk1", customerId: "c1", tokenLink: "https://store.test/sign/tok" }, "https://store.test/"), "https://store.test/party/bk1/contract");
  assert.equal(contractReadyLink({ bookingId: "bk1", customerId: null, tokenLink: "https://store.test/sign/tok" }, "https://store.test"), "https://store.test/sign/tok");
  assert.equal(contractReadyLink({ bookingId: "bk1", customerId: "c1", tokenLink: "https://api/x" }, undefined), "https://api/x");
});

test("retainer overdue: tier 2, unpaid, past the contract's confirm-by date", () => {
  const b = { status: "Signed", retainerPaid: false, tier: 2, agreement: { confirmByDate: "October 17, 2026" } };
  assert.equal(retainerOverdue(b, new Date("2026-10-17T20:00:00Z")), false);
  assert.equal(retainerOverdue(b, new Date("2026-10-19T12:00:00Z")), true);
  assert.equal(retainerOverdue({ ...b, retainerPaid: true }, new Date("2026-10-19T12:00:00Z")), false);
  assert.equal(retainerOverdue({ ...b, tier: 1 }, new Date("2026-10-19T12:00:00Z")), false);
  assert.equal(retainerOverdue({ ...b, status: "Released" }, new Date("2026-10-19T12:00:00Z")), false);
});
