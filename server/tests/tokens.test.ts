import assert from "node:assert/strict";
import { test } from "node:test";
import { TOKEN_CATALOG, camelToSnake, mergeFields, referencedTokens, renderMessage } from "../tokens.js";
import { sampleValues } from "../messageContext.js";
import { TRIGGERS } from "../triggers.js";

const sample = sampleValues();

test("camelCase and snake_case are the same token", () => {
  assert.equal(camelToSnake("customerFirstName"), "customer_first_name");
  assert.equal(camelToSnake("customer_first_name"), "customer_first_name");
  assert.equal(mergeFields("{{customerFirstName}}/{{customer_first_name}}/{{ customerFirstName }}", { customer_first_name: "Sam" }), "Sam/Sam/Sam");
});

test("policy text keeps its behavior: unknown tokens stay exactly as typed", () => {
  assert.equal(mergeFields("A {{depositPercentage}}% deposit, {{nope}}", { deposit_percentage: "20" }), "A 20% deposit, {{nope}}");
});

test("every token in the catalog resolves from a full set of values", () => {
  for (const t of TOKEN_CATALOG) {
    const r = renderMessage(`x {{${t.key}}} y`, sample, [t.key]);
    assert.deepEqual(r.empty, [], t.key);
    assert.deepEqual(r.notAllowed, [], t.key);
    assert.equal(r.text, `x ${t.example} y`, t.key);
  }
});

test("a token with no value blocks the message and is named", () => {
  const r = renderMessage("Hi {{customerFirstName}}, sign: {{contractLink}}", { customer_first_name: "Sam" }, ["customerFirstName", "contractLink"]);
  assert.deepEqual(r.empty, ["contractLink"]);
  assert.match(r.text, /\{\{contractLink\}\}/);
});

test("an empty or blank value counts as missing", () => {
  assert.deepEqual(renderMessage("{{eventTime}}", { event_time: "" }, ["eventTime"]).empty, ["eventTime"]);
  assert.deepEqual(renderMessage("{{eventTime}}", { event_time: "   " }, ["eventTime"]).empty, ["eventTime"]);
});

test("a token the message may not use is rejected even if it has a value", () => {
  const r = renderMessage("{{gigLink}}", sample, ["customerFirstName"]);
  assert.deepEqual(r.notAllowed, ["gigLink"]);
});

test("referencedTokens lists each token once, as typed", () => {
  assert.deepEqual(referencedTokens("{{a}} {{b_c}} {{a}} {{ dE }}"), ["a", "b_c", "dE"]);
});

test("the registry has every trigger that was asked for, once each", () => {
  const want = [
    "lead_new_ack", "lead_cart_abandoned_1h", "lead_cart_abandoned_24h", "lead_hold_expiring", "lead_nurture_day3", "lead_nurture_day10", "lead_concierge_ack",
    "contract_sent", "contract_signed", "retainer_paid", "booking_confirmed", "contract_unsigned_nudge", "balance_due_reminder", "event_week_reminder", "event_eve_reminder", "post_event_thanks",
    "gig_bid_invite", "bid_accepted", "bid_not_selected", "crew_reminder_30", "crew_reminder_15", "crew_reminder_7", "crew_reminder_3", "crew_reminder_eve",
  ];
  const keys = TRIGGERS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  for (const k of want) assert.ok(keys.includes(k), k);
});

test("send classes are as specified", () => {
  const cls = Object.fromEntries(TRIGGERS.map((t) => [t.key, t.sendClass]));
  for (const k of ["lead_new_ack", "lead_hold_expiring", "lead_concierge_ack", "contract_sent", "contract_signed", "retainer_paid", "booking_confirmed", "gig_bid_invite", "bid_accepted", "bid_not_selected"]) assert.equal(cls[k], "transactional", k);
  for (const k of ["lead_cart_abandoned_1h", "lead_cart_abandoned_24h", "lead_nurture_day3", "lead_nurture_day10"]) assert.equal(cls[k], "nurture", k);
  for (const k of ["contract_unsigned_nudge", "balance_due_reminder", "event_week_reminder", "event_eve_reminder", "post_event_thanks", "crew_reminder_30", "crew_reminder_15", "crew_reminder_7", "crew_reminder_3", "crew_reminder_eve"]) assert.equal(cls[k], "reminder", k);
});

test("every default uses only tokens its trigger allows, and only tokens that exist", () => {
  const known = new Set(TOKEN_CATALOG.map((t) => camelToSnake(t.key)));
  for (const t of TRIGGERS) {
    const allowed = new Set(t.tokens.map(camelToSnake));
    for (const k of t.tokens) assert.ok(known.has(camelToSnake(k)), `${t.key} lists unknown token ${k}`);
    for (const text of [t.sms, t.emailSubject, t.emailBody]) {
      for (const used of referencedTokens(text)) assert.ok(allowed.has(camelToSnake(used)), `${t.key} uses {{${used}}} without allowing it`);
    }
  }
});

test("every default renders cleanly with full sample values", () => {
  for (const t of TRIGGERS) {
    for (const text of [t.sms, t.emailSubject, t.emailBody]) {
      const r = renderMessage(text, sample, t.tokens);
      assert.deepEqual([r.empty, r.notAllowed], [[], []], t.key);
    }
  }
});

test("brand voice: no em dashes, no exclamation points of our own, no banned words", () => {
  const banned = /unforgettable|elevate|seamless|one of a kind|dream|magical|premier|proud to/i;
  for (const t of TRIGGERS) {
    for (const text of [t.sms, t.emailSubject, t.emailBody]) {
      assert.ok(!text.includes("—") && !text.includes("–"), `${t.key} has a dash`);
      assert.ok(!text.includes("!"), `${t.key} has an exclamation point`);
      assert.ok(!banned.test(text), `${t.key} uses a banned word`);
    }
  }
});

test("every nurture text ends with the opt-out line", () => {
  for (const t of TRIGGERS.filter((x) => x.sendClass === "nurture")) assert.ok(t.sms.endsWith("Reply STOP to opt out."), t.key);
});

test("every crew reminder carries the gig link and the confirm wording", () => {
  const reminders = TRIGGERS.filter((t) => t.key.startsWith("crew_reminder_"));
  assert.equal(reminders.length, 5);
  for (const t of reminders) {
    assert.ok(t.tokens.includes("gigLink") && t.sms.includes("{{gigLink}}"), t.key);
    assert.ok(t.sms.includes("Tap to confirm you're set or flag a question"), t.key);
  }
});

test("existing sends keep their exact wording", () => {
  const sms = (k: string) => TRIGGERS.find((t) => t.key === k)!.sms;
  assert.equal(sms("contract_sent"), "Hi {{customerFirstName}}, your {{companyName}} contract for {{eventDate}} is ready to review and sign: {{contractLink}}");
  assert.equal(sms("retainer_paid"), "Hi {{customerFirstName}}, we received your retainer for {{eventDate}}. Thank you. Your date is confirmed once the contract is signed too.");
  assert.equal(sms("booking_confirmed"), "Hi {{customerFirstName}}, your {{companyName}} booking for {{eventDate}} is confirmed. We're looking forward to your event.");
  assert.equal(sms("contract_signed"), "Thanks {{customerFirstName}}, your {{companyName}} contract for {{eventDate}} is signed. Your copy: {{contractPdfLink}}");
  assert.equal(sms("contract_signed_recorded"), "Thanks {{customerFirstName}}, we have your signed contract for {{eventDate}}. The next step is the retainer payment to confirm your date.");
  assert.equal(sms("booking_cancelled"), "Hi {{customerFirstName}}, your {{companyName}} booking for {{eventDate}} has been cancelled. If that doesn't look right, please call or text us.");
  assert.equal(sms("balance_due_reminder"), "Hi {{customerFirstName}}, a reminder that the remaining balance of {{balanceDue}} for your {{companyName}} event on {{eventDate}} is coming due. Please call or text us to arrange payment.");
  assert.equal(sms("gig_bid_invite"), "Hi {{crewFirstName}}, {{companyName}} has a {{gigRole}} gig for {{gigItemName}} on {{gigDate}}. Can you take it? Please call or text us back to say yes or no.");
  assert.equal(sms("staff_contract_signed"), "Signed: {{customerName}} signed the contract for {{eventDate}}. {{contractPdfLink}}");
});
