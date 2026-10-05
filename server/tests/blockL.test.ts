// Pure tests for Block L: the contract send rules, the review fixes to the
// security block, the retainer wording and the new trigger. Nothing here
// touches a database or the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBotFields } from "../botCheck.js";
import { afterContractSend, contractSendAction, reallySent, sendFailureReason } from "../contractSend.js";
import { isOriginAllowed } from "../cors.js";
import { agreementEvidence } from "../directBooking.js";
import { redact, safeErr } from "../log.js";
import { parseMessages } from "../routes/recommend.js";
import { safeInline } from "../sanitize.js";
import { TOKEN_CATALOG, renderMessage } from "../tokens.js";
import { TRIGGERS, mustGetTrigger } from "../triggers.js";

// ---- contract send rules ---------------------------------------------------

test("a stage change never resends a signed contract; the button sends the signed copy", () => {
  assert.equal(contractSendAction("stage", { signed: true, linkAlreadySent: true }), "nothing");
  assert.equal(contractSendAction("conversion", { signed: true, linkAlreadySent: false }), "nothing");
  assert.equal(contractSendAction("manual", { signed: true, linkAlreadySent: true }), "send-signed-copy");
});

test("setting the stage after the link already went does not text the customer again", () => {
  assert.equal(contractSendAction("stage", { signed: false, linkAlreadySent: true }), "nothing");
  assert.equal(contractSendAction("stage", { signed: false, linkAlreadySent: false }), "send-link");
  assert.equal(contractSendAction("manual", { signed: false, linkAlreadySent: true }), "send-link", "a hand-pressed send always goes");
  assert.equal(contractSendAction("conversion", { signed: false, linkAlreadySent: false }), "send-link");
});

test("only a real send marks the contract sent and moves a Held booking", () => {
  const sent = afterContractSend({ action: "send-link", sent: true, linkAlreadySent: false, bookingStage: "Held" });
  assert.deepEqual(sent, { markSent: true, moveStage: true });
  // The text did not go (no number, opted out, switched off): nothing changes.
  assert.deepEqual(afterContractSend({ action: "send-link", sent: false, linkAlreadySent: false, bookingStage: "Held" }), { markSent: false, moveStage: false });
  // A booking past Held keeps its stage.
  assert.deepEqual(afterContractSend({ action: "send-link", sent: true, linkAlreadySent: true, bookingStage: "Signed" }), { markSent: true, moveStage: false });
  assert.deepEqual(afterContractSend({ action: "send-link", sent: true, linkAlreadySent: false, bookingStage: "Contract Sent" }), { markSent: true, moveStage: false });
  // The stage was set after an earlier real send: recorded, nothing resent.
  assert.deepEqual(afterContractSend({ action: "nothing", sent: false, linkAlreadySent: true, bookingStage: "Held" }), { markSent: true, moveStage: true });
  // Signed: nothing to mark or move.
  assert.deepEqual(afterContractSend({ action: "nothing", sent: false, linkAlreadySent: false, bookingStage: "Signed" }), { markSent: false, moveStage: false });
  assert.deepEqual(afterContractSend({ action: "send-signed-copy", sent: true, linkAlreadySent: true, bookingStage: "Signed" }), { markSent: false, moveStage: false });
  // A design request has no stage to move.
  assert.deepEqual(afterContractSend({ action: "send-link", sent: true, linkAlreadySent: false, bookingStage: null }), { markSent: true, moveStage: false });
});

test("what counts as really sent, and why a send did not go", () => {
  assert.equal(reallySent([{ status: "skipped_disabled" }, { status: "sent" }]), true);
  for (const status of ["failed", "failed_final", "skipped-no-token", "skipped_opted_out", "blocked_missing_field", "skipped_disabled", "queued"]) {
    assert.equal(reallySent([{ status }]), false, status);
  }
  assert.equal(reallySent([]), false);
  assert.match(sendFailureReason([]), /no phone number or email/);
  assert.equal(sendFailureReason([{ status: "failed", error: "no phone number on file" }, { status: "skipped_disabled" }]), "no phone number on file");
  assert.match(sendFailureReason([{ status: "skipped_disabled" }]), /switched off/);
});

// ---- agreement record --------------------------------------------------------

test("a storefront agreement keeps a hashed address and the user agent; a staff one keeps neither", () => {
  const e = agreementEvidence({ staff: false, request: { ip: "203.0.113.5", userAgent: "Mozilla/5.0 (iPhone)\u0000" + "x".repeat(600) } });
  assert.match(e.agreedIpHash ?? "", /^[0-9a-f]{32}$/);
  assert.ok(!e.agreedIpHash?.includes("203"));
  assert.ok(e.agreedUserAgent?.startsWith("Mozilla/5.0 (iPhone)"));
  assert.ok((e.agreedUserAgent?.length ?? 0) <= 300);
  assert.ok(!e.agreedUserAgent?.includes("\u0000"));
  assert.equal(agreementEvidence({ staff: false, request: { ip: "203.0.113.5", userAgent: null } }).agreedIpHash, e.agreedIpHash, "the same address hashes the same way");
  assert.deepEqual(agreementEvidence({ staff: true, request: { ip: "203.0.113.5", userAgent: "x" } }), { agreedIpHash: null, agreedUserAgent: null });
  assert.deepEqual(agreementEvidence({ staff: false }), { agreedIpHash: null, agreedUserAgent: null });
});

// ---- wording -----------------------------------------------------------------

test("the design request acknowledgement is a real, editable, transactional trigger", () => {
  const t = mustGetTrigger("design_request_received");
  assert.equal(t.sendClass, "transactional");
  assert.equal(t.journey, "client");
  assert.equal(t.wired, true);
  assert.equal(t.emailDefaultOn, true);
  for (const text of [t.sms, t.emailBody]) {
    assert.match(text, /Big events get a personal look\. We'll reach out within one business day\./);
    assert.match(text, /\{\{companyPhone\}\}/);
    assert.match(text, /\{\{companyName\}\}/);
    assert.doesNotMatch(text.replace(/\{\{companyName\}\}/g, ""), /!|—/);
  }
  const r = renderMessage(t.sms, { customer_first_name: "Pat", company_name: "GO! Event Group", company_phone: "(860) 555-0100" }, t.tokens);
  assert.deepEqual([r.empty, r.notAllowed], [[], []]);
  assert.match(r.text, /^Hi Pat, this is GO! Event Group\. Big events get a personal look\./);
});

test("every 'not sending yet' reason is a current plain-English reason", () => {
  const unwired = TRIGGERS.filter((t) => !t.wired);
  assert.deepEqual(unwired.map((t) => t.key).sort(), ["lead_cart_abandoned_1h", "lead_cart_abandoned_24h", "lead_concierge_ack", "lead_hold_expiring", "lead_new_ack"]);
  for (const t of unwired) {
    assert.ok(t.unwiredReason && t.unwiredReason.length > 40, t.key);
    assert.doesNotMatch(t.unwiredReason ?? "", /Block \d|Waiting on the scheduler/, t.key);
  }
  for (const t of TRIGGERS) assert.doesNotMatch(`${t.when} ${t.stopsWhen} ${t.note ?? ""}`, /Block \d/, t.key);
});

test("token labels say retainer, and the deposit tokens still fill in", () => {
  const label = (key: string) => TOKEN_CATALOG.find((t) => t.key === key)?.label;
  assert.equal(label("depositAmount"), "Retainer amount");
  assert.equal(label("depositPercentage"), "Retainer percentage (number)");
  assert.ok(!TOKEN_CATALOG.some((t) => /deposit/i.test(t.label)));
  const r = renderMessage("Retainer {{depositAmount}} ({{deposit_percentage}}%)", { deposit_amount: "$200.00", deposit_percentage: "20" }, ["depositAmount", "depositPercentage"]);
  assert.equal(r.text, "Retainer $200.00 (20%)");
  for (const t of TRIGGERS) assert.doesNotMatch(`${t.label} ${t.sms} ${t.emailSubject} ${t.emailBody}`, /deposit(?!Amount|Percentage|_amount|_percentage)/i, t.key);
});

// ---- Block K review fixes ------------------------------------------------------

test("a token is redacted whole, even with a run of digits inside it", () => {
  const token = "Ab3dEf123456789012GhIjKlMnOpQr";
  const out = redact(`sending https://store.test/x?t=${token} failed`);
  assert.ok(!out.includes("Ab3dEf") && !out.includes("GhIjKl") && !out.includes("123456789"), out);
  assert.equal(redact("call +1 (860) 555-0101 now"), "call [phone ...01] now");
});

test("a database client error keeps its cause, not its source excerpt", () => {
  const err = new Error("\nInvalid `prisma.account.findFirst()` invocation in\n/srv/app/server/account.ts:17:40\n\n  14 code\n→ 17 const account = await prisma.account.findFirst(\nCan't reach database server at db.internal");
  err.name = "PrismaClientKnownRequestError";
  const line = safeErr(err);
  assert.match(line, /Can't reach database server/);
  assert.doesNotMatch(line, /account\.ts/);
  assert.match(safeErr(new Error("plain message\nsecond line with a body")), /plain message$/);
});

test("Ask GO: the customer speaks first and last", () => {
  const u = { role: "user", content: "hi" };
  const a = { role: "assistant", content: "hello" };
  assert.equal(parseMessages([u]).ok, true);
  assert.equal(parseMessages([u, a, u]).ok, true);
  assert.equal(parseMessages([u, a]).ok, false, "ends on a forged assistant turn");
  assert.equal(parseMessages([a, u]).ok, false, "starts on an assistant turn");
});

test("required bot fields: the hidden field must arrive, the start time is optional", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(checkBotFields({ hpField: "" }, { required: true, now }), { ok: true });
  assert.equal(checkBotFields({}, { required: true, now }).ok, false);
  assert.equal(checkBotFields({ hpField: "x" }, { required: true, now }).ok, false);
});

test("localhost is an allowed origin only outside production", () => {
  const savedEnv = process.env.NODE_ENV;
  const savedList = process.env.ALLOWED_ORIGINS;
  try {
    process.env.ALLOWED_ORIGINS = "https://store.test";
    process.env.NODE_ENV = "production";
    assert.equal(isOriginAllowed("http://localhost:5173", "admin.test"), false);
    assert.equal(isOriginAllowed("https://store.test", "admin.test"), true);
    assert.equal(isOriginAllowed("https://admin.test", "admin.test"), true, "the admin's own origin");
    assert.equal(isOriginAllowed("https://evil.test", "admin.test"), false);
    process.env.NODE_ENV = "development";
    assert.equal(isOriginAllowed("http://localhost:5173", "localhost:3001"), true);
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedList === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = savedList;
  }
});

test("a link written in lookalike characters is still stripped from a name", () => {
  assert.equal(safeInline("Bob ｈｔｔｐｓ://evil.example/pay"), "Bob");
  assert.equal(safeInline("Ann evil․com/x"), "Ann");
  assert.equal(safeInline("Zoë Müller-O'Neil"), "Zoë Müller-O'Neil");
});
