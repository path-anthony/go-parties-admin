// Block A11, on a throwaway database: which bookings are weddings, the
// prefill, saving, submitting, ownership, the notifications, the reminders
// through the real scheduler pass, and the staff routes and print page.
// Twilio and the email webhook are stubbed. Every row made here is deleted.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.EMAIL_WEBHOOK_URL = "https://email.test/hook";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { requireAuth } from "../auth.js";
import { runAutomation } from "../automation/runner.js";
import { addDays, atEastern, easternDay } from "../automation/time.js";
import { prisma } from "../db.js";
import { runTimedNotifications } from "../notifications.js";
import bookingsRouter from "../routes/bookings.js";
import customerRouter from "../routes/customer.js";
import { adminWeddingRouter } from "../routes/weddingDetails.js";
import { customerWriteGuard } from "../security.js";
import { automaticWedding, dueDateFor, isWeddingBooking } from "../weddingDetails/logic.js";
import { TEMPLATE_V1, allFields, sectionFields } from "../weddingDetails/template.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("weddingDetails.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let policyId = "";
let madePolicy: string | null = null;
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { bookings: [] as string[], customers: [] as string[], packages: [] as string[], templates: [] as string[] };
const emails: { to: string; subject: string; body: string; purpose: string }[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  if (url === process.env.EMAIL_WEBHOOK_URL) {
    emails.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
  return realFetch(input, init);
}) as typeof fetch;

const NOW = new Date();
const dayFromNow = (n: number) => addDays(easternDay(NOW), n);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

type Res = { status: number; json: Record<string, any>; cookie: string | null; text: string };
async function call(path: string, method: string, body?: unknown, cookie?: string, ip?: string): Promise<Res> {
  const headers: Record<string, string> = { Origin: "https://store.test" };
  if (ip) headers["X-Forwarded-For"] = ip;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const r = await realFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get("set-cookie");
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* the print page is HTML */
  }
  return { status: r.status, json, cookie: set ? set.split(";")[0] : null, text };
}

let counter = 0;
type Over = { eventIn?: number; occasion?: string | null; packageId?: string | null; override?: boolean | null; customerId?: string | null; address?: string | null; status?: string; email?: string | null };
async function mkBooking(o: Over = {}): Promise<string> {
  counter += 1;
  const id = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: { accountId, eventDate: asDate(dayFromNow(o.eventIn ?? 90)), customerName: `${ZZ} Bride ${counter}`, email: o.email === undefined ? `zz-a11-b${counter}@example.test` : o.email, phone: "+15005550501", status: o.status ?? "Signed", occasion: o.occasion === undefined ? "Reception only" : o.occasion, packageId: o.packageId ?? null, weddingOverride: o.override ?? null, customerId: o.customerId ?? null, address: o.address === undefined ? "1 Venue Way, Avon, CT 06001" : o.address },
    });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policyId, checkboxChecked: true } });
    return b.id;
  });
  made.bookings.push(id);
  return id;
}
let signups = 0;
async function signUp(homeAddress: string | null = "12 Home St, Avon, CT 06001") {
  signups += 1;
  const r = await call("/api/customer/signup", "POST", { name: `${ZZ} Holder ${signups}`, phone: `+150055506${String(signups).padStart(2, "0")}`, email: `zz-a11-${signups}@example.test`, password: "a-long-enough-password", homeAddress }, undefined, `10.11.0.${signups}`);
  assert.equal(r.status, 201, r.text);
  made.customers.push(r.json.customer.id);
  return { id: r.json.customer.id as string, cookie: r.cookie as string, email: r.json.customer.email as string };
}
const path = (id: string) => `/api/customer/bookings/${id}/wedding-details`;
const ofType = (type: string, bookingId?: string) => prisma.notification.findMany({ where: { accountId, type, ...(bookingId ? { bookingId } : {}) } });
const REQUIRED = TEMPLATE_V1.sections.filter((s) => s.required);
// One answer in every required section, none of them prefilled.
const fillRequired = () =>
  Object.fromEntries(
    REQUIRED.map((s) => {
      const f = sectionFields(s).find((x) => x.type === "time" || (x.type === "text" && !/bride_|reception_location/.test(x.key))) as (typeof TEMPLATE_V1.cover)[number];
      return [f.key, "x"];
    }),
  );

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const existing = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  const policy = existing ?? (await prisma.policyVersion.create({ data: { accountId, version: 1, text: `${ZZ} rental policy.` } }));
  policyId = policy.id;
  if (!existing) madePolicy = policy.id;
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/customer", customerWriteGuard);
  app.use(express.json({ limit: "128kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/customer", customerRouter);
  const staff = (_req: express.Request, _res: express.Response, next: express.NextFunction) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  app.use("/api/bookings", staff, adminWeddingRouter);
  app.use("/api/bookings", staff, bookingsRouter);
  app.use("/api/gated", requireAuth, adminWeddingRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  emails.length = 0;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  const n = await prisma.notification.deleteMany({ where: { accountId } });
  const logs = await prisma.messageLog.deleteMany({ where: { OR: [{ bookingId: { in: made.bookings } }, { triggerKey: { startsWith: "wedding_details" } }] } });
  const t = await prisma.messageTemplate.deleteMany({ where: { id: { in: made.templates } } });
  const b = await prisma.booking.deleteMany({ where: { OR: [{ id: { in: made.bookings } }, { customerName: { startsWith: ZZ } }] } });
  const c = await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
  const p = await prisma.package.deleteMany({ where: { id: { in: made.packages } } });
  if (madePolicy) await prisma.policyVersion.delete({ where: { id: madePolicy } });
  const left = { rows: await prisma.weddingDetails.count({ where: { accountId } }), bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }) };
  console.log(`# cleanup: ${n.count} notifications, ${logs.count} message logs, ${t.count} templates, ${b.count} bookings, ${c.count} customers, ${p.count} packages; remaining ${JSON.stringify(left)}`);
  await prisma.$disconnect();
});

test("the template: no em dashes anywhere in its copy", () => {
  const strings: string[] = [TEMPLATE_V1.title, TEMPLATE_V1.subtitle, TEMPLATE_V1.tagline, TEMPLATE_V1.preparedFor, TEMPLATE_V1.note.text, TEMPLATE_V1.thanks];
  for (const h of TEMPLATE_V1.howTo) strings.push(h.title, h.text);
  for (const f of allFields(TEMPLATE_V1)) strings.push(f.label, f.help ?? "", ...(f.options ?? []).map((o) => o.label));
  for (const s of TEMPLATE_V1.sections) {
    strings.push(s.title, s.subtitle);
    for (const it of s.items) {
      if (it.kind === "note") strings.push(it.text, it.tag ?? "");
      if (it.kind === "heading") strings.push(it.text, it.help ?? "");
      if (it.kind === "group") strings.push(it.title, it.note ?? "");
    }
  }
  assert.ok(strings.length > 300);
  for (const text of strings) assert.doesNotMatch(text, /[\u2014\u2013]/, text);
});

test("the template: 14 sections, 10 required, unique keys, and the item counts printed on the form", () => {
  assert.equal(TEMPLATE_V1.version, 1);
  assert.deepEqual(TEMPLATE_V1.sections.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(TEMPLATE_V1.sections.filter((s) => !s.required).map((s) => s.key), ["content_creation", "trends", "additional_notes", "social_media"]);
  const keys = allFields(TEMPLATE_V1).map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const s of TEMPLATE_V1.sections) for (const f of sectionFields(s)) assert.ok(f.key.startsWith(`${s.key}.`), f.key);
  const groups = Object.fromEntries(TEMPLATE_V1.sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "group" ? [[i.key, i.fields.length]] : []))));
  assert.deepEqual(groups, { "bride_prep.details": 9, "bride_prep.candid": 9, "groom_prep.details": 8, "groom_prep.candid": 5, "ceremony.scene": 4, "ceremony.moments": 12, "bride_groom.moments": 6, "reception.details": 6, "reception.moments": 11, "content_creation.capture": 10, "content_creation.checklist": 16 });
  assert.equal(dueDateFor("2026-12-12"), "2026-11-12");
});

test("wedding detection: occasion, package, and the staff override both ways", () => {
  const wed = (over: Partial<Parameters<typeof isWeddingBooking>[0]>) => isWeddingBooking({ weddingOverride: null, occasion: null, package: null, ...over });
  assert.equal(wed({ occasion: "Reception only" }), true, "a wedding sub-occasion");
  assert.equal(wed({ occasion: "Wedding" }), true, "the group itself");
  assert.equal(wed({ occasion: "Birthday" }), false);
  assert.equal(wed({}), false);
  assert.equal(wed({ package: { occasions: ["Holiday party", "Ceremony + reception"] } }), true, "no occasion on the booking, so the package's wedding occasion counts");
  assert.equal(wed({ package: { occasions: ["Holiday party"] } }), false);
  const both = { occasions: ["Ceremony + reception", "Holiday party"] };
  assert.equal(wed({ occasion: "Holiday party", package: both }), false, "the booking's own non-wedding occasion beats the package");
  assert.equal(wed({ occasion: "Birthday", package: both }), false);
  assert.equal(wed({ occasion: "Reception only", package: { occasions: ["Holiday party"] } }), true, "and its own wedding occasion wins over a non-wedding package");
  assert.equal(wed({ occasion: "  ", package: both }), true, "a blank occasion is no occasion");
  assert.equal(wed({ occasion: "Holiday party", package: both, weddingOverride: true }), true, "the staff switch beats both, on");
  assert.equal(wed({ occasion: "Reception only", package: both, weddingOverride: false }), false, "and off");
  assert.equal(wed({ occasion: "Birthday", weddingOverride: true }), true, "staff turned it on");
  assert.equal(wed({ occasion: "Reception only", weddingOverride: false }), false, "staff turned it off");
  assert.equal(automaticWedding({ occasion: "Reception only", package: null }), true);
});

test("the form is prefilled from the booking and account, those fields are locked, and an empty one stays editable", async () => {
  const c = await signUp();
  const id = await mkBooking({ customerId: c.id, eventIn: 120 });
  assert.equal(await prisma.weddingDetails.count({ where: { bookingId: id } }), 0, "nothing until it is read");
  const r = await call(path(id), "GET", undefined, c.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(await prisma.weddingDetails.count({ where: { bookingId: id } }), 1, "made on first read");
  await call(path(id), "GET", undefined, c.cookie);
  assert.equal(await prisma.weddingDetails.count({ where: { bookingId: id } }), 1, "and only once");
  assert.equal(r.json.status, "not_started");
  assert.equal(r.json.dueDate, addDays(dayFromNow(120), -30));
  assert.equal(r.json.template.version, 1);
  assert.equal(r.json.requiredTotal, 10);
  assert.equal(r.json.requiredDone, 0, "prefilled details are not answers");
  assert.equal(r.json.prefill["couple.bride_name"], `${ZZ} Holder ${signups}`);
  assert.equal(r.json.prefill["couple.bride_email"], c.email);
  assert.equal(r.json.prefill["couple.bride_address"], "12 Home St, Avon, CT 06001");
  assert.equal(r.json.prefill["cover.reception_venue"], "1 Venue Way, Avon, CT 06001");
  assert.equal(r.json.prefill["wedding_info.reception_location"], "1 Venue Way, Avon, CT 06001");
  assert.ok(r.json.prefill["cover.event_date"]);
  for (const k of ["couple.bride_name", "couple.bride_email", "couple.bride_cell", "couple.bride_address", "cover.event_date", "wedding_info.reception_location"]) assert.ok(r.json.lockedKeys.includes(k), k);
  for (const k of ["wedding_info.ceremony_location", "cover.ceremony_venue", "bride_prep.location", "groom_prep.location"]) assert.equal(r.json.lockedKeys.includes(k), false, k);

  const locked = await call(path(id), "PATCH", { answers: { "couple.bride_name": "Someone Else" } }, c.cookie);
  assert.equal(locked.status, 400);
  assert.equal(locked.json.reason, "locked-field");
  assert.equal((await call(path(id), "PATCH", { answers: { "wedding_info.ceremony_location": "St. Mary's, Avon" } }, c.cookie)).status, 200, "ceremony venue stays editable");

  const noHome = await signUp(null);
  const bare = await mkBooking({ customerId: noHome.id, address: null });
  const v = await call(path(bare), "GET", undefined, noHome.cookie);
  assert.equal(v.json.lockedKeys.includes("couple.bride_address"), false);
  assert.equal(v.json.lockedKeys.includes("wedding_info.reception_location"), false);
  assert.equal((await call(path(bare), "PATCH", { answers: { "couple.bride_address": "5 Typed Rd", "wedding_info.reception_location": "The Barn" } }, noHome.cookie)).status, 200, "nothing to show means they can fill it in");
});

test("PATCH merges by key, validates against the template, and cleans text", async () => {
  const c = await signUp();
  const id = await mkBooking({ customerId: c.id });
  let r = await call(path(id), "PATCH", { answers: { "bride_prep.start_time": "1 PM", "bride_prep.details.veil": true, "ceremony.balcony": "not_sure" } }, c.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "in_progress");
  r = await call(path(id), "PATCH", { answers: { "groom_prep.start_time": "2 PM", "film.priorities": { dancing: 1, formalities: 2 }, "content_creation.where_post": ["tiktok", "instagram"] } }, c.cookie);
  assert.deepEqual(r.json.answers, { "bride_prep.start_time": "1 PM", "bride_prep.details.veil": true, "ceremony.balcony": "not_sure", "groom_prep.start_time": "2 PM", "film.priorities": { dancing: 1, formalities: 2 }, "content_creation.where_post": ["tiktok", "instagram"] }, "the first save is still there");
  assert.equal(r.json.requiredDone, 4, "bride, groom, ceremony, film");
  assert.deepEqual(r.json.sections.filter((s: { done: boolean }) => s.done).map((s: { key: string }) => s.key), ["film", "bride_prep", "groom_prep", "ceremony", "content_creation"], "an optional section can be done too");

  const refuse = async (answers: unknown, reason: string, field?: string) => {
    const x = await call(path(id), "PATCH", { answers }, c.cookie);
    assert.equal(x.status, 400, JSON.stringify(answers));
    assert.equal(x.json.reason, reason);
    if (field) assert.equal(x.json.field, field);
  };
  await refuse({ "bride_prep.nope": "x" }, "unknown-field", "bride_prep.nope");
  await refuse({ "bride_prep.start_time": "y".repeat(41) }, "too-long");
  await refuse({ "additional_notes.notes": "y".repeat(5001) }, "too-long");
  await refuse({ "ceremony.balcony": "maybe" }, "invalid-answer");
  await refuse({ "bride_prep.details.veil": "yes" }, "invalid-answer");
  await refuse({ "bride_prep.start_time": 12 }, "invalid-answer");
  await refuse({ "film.priorities": { dancing: 1, formalities: 1 } }, "invalid-answer");
  await refuse({ "film.priorities": { dancing: 4 } }, "invalid-answer");
  await refuse({ "content_creation.where_post": ["myspace"] }, "invalid-answer");
  await refuse("nope", "not-an-object");
  // One bad field refuses the whole save.
  await refuse({ "cocktail_hour.time": "5 PM", "x.y": 1 }, "unknown-field");
  assert.equal((await call(path(id), "GET", undefined, c.cookie)).json.answers["cocktail_hour.time"], undefined);

  r = await call(path(id), "PATCH", { answers: { "couple.groom_email": "groom@gmail.com", "trends.trend_1": "https://tiktok.com/@x/video/1", "social_media.dj": "dj.co", "bride_prep.special_requests": "Film the note\nsee www.spam.com please" } }, c.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.answers["couple.groom_email"], "groom@gmail.com", "an email survives");
  assert.equal(r.json.answers["trends.trend_1"], "https://tiktok.com/@x/video/1", "the form asks for a link here");
  assert.equal(r.json.answers["social_media.dj"], "dj.co");
  assert.equal(r.json.answers["bride_prep.special_requests"], "Film the note\nsee please", "a link in free text goes, the line break stays");

  r = await call(path(id), "PATCH", { answers: { "bride_prep.details.veil": false, "bride_prep.start_time": "", "ceremony.balcony": null } }, c.cookie);
  for (const k of ["bride_prep.details.veil", "bride_prep.start_time", "ceremony.balcony"]) assert.equal(r.json.answers[k], undefined, `${k} cleared`);
});

test("another customer's booking, a non-wedding and no session all get nothing", async () => {
  const owner = await signUp();
  const other = await signUp();
  const id = await mkBooking({ customerId: owner.id });
  for (const [method, suffix, body] of [["GET", "", undefined], ["PATCH", "", { answers: {} }], ["POST", "/submit", {}], ["POST", "/request-change", {}]] as const) {
    assert.equal((await call(`${path(id)}${suffix}`, method, body, other.cookie)).status, 404, `${method} ${suffix}`);
    assert.equal((await call(`${path(id)}${suffix}`, method, body)).status, 401, `no session ${method} ${suffix}`);
  }
  assert.equal(await prisma.weddingDetails.count({ where: { bookingId: id } }), 0, "a refused read makes nothing");
  const party = await mkBooking({ customerId: owner.id, occasion: "Birthday" });
  assert.equal((await call(path(party), "GET", undefined, owner.cookie)).status, 404);
  const off = await mkBooking({ customerId: owner.id, override: false });
  assert.equal((await call(path(off), "GET", undefined, owner.cookie)).status, 404, "staff said it is not a wedding");
  const on = await mkBooking({ customerId: owner.id, occasion: "Birthday", override: true });
  assert.equal((await call(path(on), "GET", undefined, owner.cookie)).status, 200, "staff said it is");
});

test("submit needs every required section, locks the form, notifies once; a change request does not unlock; staff unlock does", async () => {
  const c = await signUp();
  const id = await mkBooking({ customerId: c.id });
  await call(path(id), "PATCH", { answers: { "bride_prep.start_time": "1 PM" } }, c.cookie);
  let r = await call(`${path(id)}/submit`, "POST", {}, c.cookie);
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, "sections-missing");
  assert.equal(r.json.missing.length, 9);
  assert.ok(r.json.missing.some((m: { key: string }) => m.key === "couple"), "prefill alone does not finish The Couple");
  assert.equal((await call(`${path(id)}/request-change`, "POST", {}, c.cookie)).status, 409, "nothing to change yet");

  assert.equal((await call(path(id), "PATCH", { answers: fillRequired() }, c.cookie)).json.requiredDone, 10);
  r = await call(`${path(id)}/submit`, "POST", {}, c.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "submitted");
  assert.ok(r.json.submittedAt);
  assert.equal((await prisma.weddingDetails.findUniqueOrThrow({ where: { bookingId: id } })).submittedBy, `${ZZ} Holder ${signups}`);
  let notes = await ofType("wedding-details-submitted", id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Wedding details submitted");
  assert.equal(notes[0].link, `/bookings?booking=${id}`);

  const late = await call(path(id), "PATCH", { answers: { "cocktail_hour.time": "5 PM" } }, c.cookie);
  assert.equal(late.status, 409);
  assert.equal(late.json.reason, "submitted");
  assert.equal((await call(`${path(id)}/submit`, "POST", {}, c.cookie)).status, 409);
  assert.equal((await ofType("wedding-details-submitted", id)).length, 1);

  r = await call(`${path(id)}/request-change`, "POST", { note: "New venue contact" }, c.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "submitted", "a request does not unlock");
  assert.ok(r.json.changeRequestedAt);
  await call(`${path(id)}/request-change`, "POST", { note: "Second press" }, c.cookie);
  notes = await ofType("wedding-details-change-request", id);
  assert.equal(notes.length, 1, "fires once");
  assert.match(notes[0].body, /New venue contact/);
  assert.equal((await prisma.weddingDetails.findUniqueOrThrow({ where: { bookingId: id } })).changeRequestNote, "New venue contact");

  assert.equal((await call(`/api/bookings/${id}/wedding-details/unlock`, "POST", { reason: "  " })).status, 400, "a reason is required");
  r = await call(`/api/bookings/${id}/wedding-details/unlock`, "POST", { reason: "Venue changed" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.details.status, "in_progress");
  assert.equal(r.json.details.unlockReason, "Venue changed");
  assert.equal(r.json.details.submittedAt, null);
  assert.equal(r.json.details.changeRequestedAt, null);
  assert.equal((await call(`/api/bookings/${id}/wedding-details/unlock`, "POST", { reason: "Again" })).status, 409);
  assert.equal((await call(path(id), "PATCH", { answers: { "cocktail_hour.time": "5 PM" } }, c.cookie)).status, 200, "open again");
  assert.equal((await call(`${path(id)}/submit`, "POST", {}, c.cookie)).status, 200);
  assert.equal((await ofType("wedding-details-submitted", id)).length, 2, "a resubmission is news");
});

test("content-creation-interest fires once for yes or maybe, never for no thanks", async () => {
  const c = await signUp();
  const no = await mkBooking({ customerId: c.id });
  await call(path(no), "PATCH", { answers: { "content_creation.interested": "no" } }, c.cookie);
  assert.equal((await ofType("content-creation-interest", no)).length, 0);
  const id = await mkBooking({ customerId: c.id });
  await call(path(id), "PATCH", { answers: { "content_creation.interested": "maybe" } }, c.cookie);
  await call(path(id), "PATCH", { answers: { "content_creation.interested": "yes" } }, c.cookie);
  const rows = await ofType("content-creation-interest", id);
  assert.equal(rows.length, 1, "once per booking");
  assert.equal(rows[0].title, "Upsell: content creation");
  assert.match(rows[0].body, /Maybe, tell me more/);
});

test("the time checks pick the right weddings and fire once", async () => {
  await prisma.notification.deleteMany({ where: { accountId } });
  const c = await signUp();
  const in50 = await mkBooking({ eventIn: 50 });
  const in30 = await mkBooking({ eventIn: 30 });
  await mkBooking({ eventIn: 61 });
  await mkBooking({ eventIn: 30, occasion: "Birthday" });
  await mkBooking({ eventIn: 30, status: "Cancelled" });
  await mkBooking({ eventIn: -1 });
  const started = await mkBooking({ eventIn: 30, customerId: c.id });
  await call(path(started), "PATCH", { answers: { "bride_prep.start_time": "1 PM" } }, c.cookie);
  const startedFar = await mkBooking({ eventIn: 50, customerId: c.id });
  await call(path(startedFar), "PATCH", { answers: { "bride_prep.start_time": "1 PM" } }, c.cookie);
  const done = await mkBooking({ eventIn: 30, customerId: c.id });
  await call(path(done), "PATCH", { answers: fillRequired() }, c.cookie);
  await call(`${path(done)}/submit`, "POST", {}, c.cookie);
  const unmarked = await mkBooking({ eventIn: 30, occasion: "Birthday", override: true });

  await runTimedNotifications(NOW);
  await runTimedNotifications(NOW);
  const ids = async (t: string) => (await ofType(t)).map((r) => r.bookingId).sort();
  assert.deepEqual(await ids("wedding-details-not-started-60d"), [in50, in30, unmarked].sort());
  assert.deepEqual(await ids("wedding-details-incomplete-35d"), [in30, started, unmarked].sort());
  assert.match((await ofType("wedding-details-not-started-60d", in50))[0].body, /50 days out, not started\. Due /);
});

test("the reminders are off until the email is switched on, then send once at 60 days, and stop when submitted", async () => {
  const c = await signUp();
  const eventDay = dayFromNow(120);
  const id = await mkBooking({ customerId: c.id, eventIn: 120 });
  const at60 = atEastern(addDays(eventDay, -60), 10, 30);
  const mine = () => emails.filter((e) => e.purpose.startsWith("wedding_details_reminder"));
  await runAutomation({ dryRun: false, source: "admin", now: at60 });
  assert.equal(mine().length, 0, "the store has no form page yet, so the email starts off");

  for (const triggerKey of ["wedding_details_reminder_60", "wedding_details_reminder_35"]) {
    const row = await prisma.messageTemplate.create({ data: { accountId, triggerKey, channel: "email", enabled: true } });
    made.templates.push(row.id);
  }
  await runAutomation({ dryRun: false, source: "admin", now: at60 });
  assert.equal(mine().length, 1);
  const mail = mine().find((e) => e.body.includes(`/party/${id}/wedding-details`));
  assert.ok(mail, "links to this booking's form");
  assert.match(mail.subject, /^Your wedding details are due \w+, \w+ \d+$/);
  assert.doesNotMatch(`${mail.subject} ${mail.body}`, /—/);
  await runAutomation({ dryRun: false, source: "admin", now: new Date(at60.getTime() + 3_600_000) });
  assert.equal(mine().length, 1, "never twice");
  assert.equal(await prisma.messageLog.count({ where: { bookingId: id, triggerKey: "wedding_details_reminder_60" } }), 1, "shows once in the Sent log");

  await call(path(id), "PATCH", { answers: fillRequired() }, c.cookie);
  await call(`${path(id)}/submit`, "POST", {}, c.cookie);
  emails.length = 0;
  await runAutomation({ dryRun: false, source: "admin", now: atEastern(addDays(eventDay, -35), 10, 30) });
  assert.equal(mine().filter((e) => e.body.includes(id)).length, 0, "submitted, so no 35 day reminder");
});

test("staff panel, the wedding switch, the bookings filter and the print page", async () => {
  const c = await signUp();
  const id = await mkBooking({ customerId: c.id, eventIn: 40 });
  await call(path(id), "PATCH", { answers: { "couple.groom_name": `<b>Sam</b> Groom`, "bride_prep.details.veil": true, "ceremony.balcony": "not_sure", "film.priorities": { dancing: 1, formalities: 2 } } }, c.cookie);

  let r = await call(`/api/bookings/${id}/wedding-details`, "GET");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.isWedding, true);
  assert.equal(r.json.details.requiredDone, 4, "couple, film, bride prep, ceremony");
  assert.equal(r.json.details.requiredTotal, 10);
  assert.equal(r.json.details.dueDate, addDays(dayFromNow(40), -30));
  const prep = r.json.details.sections.find((s: { key: string }) => s.key === "bride_prep");
  assert.deepEqual(prep.rows, [{ group: "DETAILS", label: "Veil", value: null }], "only what is ticked");
  const film = r.json.details.sections.find((s: { key: string }) => s.key === "film");
  assert.deepEqual(film.rows.map((x: { value: string }) => x.value), ["1. Dancing, 2. Formalities"]);
  assert.equal(r.json.details.sections.find((s: { key: string }) => s.key === "reception").rows.length, 0);

  const page = await call(`/api/bookings/${id}/wedding-details/print`, "GET");
  assert.equal(page.status, 200);
  assert.match(page.text, /<!doctype html>/);
  assert.match(page.text, /VIDEOGRAPHY DETAILS &amp; SHOT LIST/);
  assert.match(page.text, /ZZTEST Holder \d+ &amp;/, "the couple's names");
  assert.match(page.text, /Veil/);
  assert.match(page.text, /Not sure/);
  assert.match(page.text, /DETAILS DUE/);
  assert.doesNotMatch(page.text, /Shoes/, "only what is ticked");
  assert.doesNotMatch(page.text, /<b>Sam/, "customer text is escaped");
  assert.doesNotMatch(page.text, /<script/);

  const list = async () => (await realFetch(`${base}/api/bookings`).then((x) => x.json())) as { id: string; isWedding: boolean; weddingDetailsMissing: boolean }[];
  const far = await mkBooking({ customerId: c.id, eventIn: 46 });
  const party = await mkBooking({ occasion: "Birthday", eventIn: 40 });
  let rows = await list();
  const flag = (x: string) => rows.find((b) => b.id === x);
  assert.equal(flag(id)?.weddingDetailsMissing, true);
  assert.equal(flag(far)?.weddingDetailsMissing, false, "more than 45 days out");
  assert.equal(flag(far)?.isWedding, true);
  assert.equal(flag(party)?.weddingDetailsMissing, false);

  r = await call(`/api/bookings/${party}/wedding`, "PATCH", { weddingOverride: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.isWedding, true);
  assert.equal(r.json.automatic, false);
  rows = await list();
  assert.equal(flag(party)?.weddingDetailsMissing, true);
  r = await call(`/api/bookings/${party}/wedding`, "PATCH", { weddingOverride: null });
  assert.equal(r.json.isWedding, false);
  assert.equal(r.json.details, null);
  assert.equal((await call(`/api/bookings/${party}/wedding-details/print`, "GET")).status, 404);
  assert.equal((await call(`/api/bookings/${party}/wedding`, "PATCH", { weddingOverride: "yes" })).status, 400);

  assert.equal((await call(`/api/gated/${id}/wedding-details`, "GET")).status, 401, "staff routes need the admin session");
  assert.equal((await call(`/api/gated/${id}/wedding-details/print`, "GET")).status, 401);
  assert.equal((await call(`/api/gated/${id}/wedding-details/unlock`, "POST", { reason: "x" })).status, 401);
});
