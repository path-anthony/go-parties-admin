// Block U: staff accounts and roles, driven over HTTP through the real
// routers. Needs a throwaway database with the migrations applied
// (DATABASE_URL points at it; the suite refuses the production database
// by name). Email goes to a fake webhook that keeps the invite and reset
// links. Every row made here is deleted at the end and the counts shown.
process.env.ADMIN_PASSWORD = "shared-login-password";
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.EMAIL_WEBHOOK_URL = "http://email.test/hook";
process.env.PUBLIC_API_URL = "https://admin.test";
process.env.NODE_ENV = "test";
delete process.env.ADMIN_EMAIL;

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { requireAuth, requireOwner } from "../auth.js";
import { prisma } from "../db.js";
import authRouter from "../routes/auth.js";
import customerRouter from "../routes/customer.js";
import integrationsRouter from "../routes/integrations.js";
import leadsRouter from "../routes/leads.js";
import settingsRouter from "../routes/settings.js";
import teamRouter from "../routes/team.js";
import { totp } from "../totp.js";
import { BOOTSTRAP_EMAIL } from "../users.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("team.test.ts runs only against a throwaway database (name containing zz_scratch)");

// ---- the fake email webhook: keeps every link that goes out ----------------------------
const mails: { to: string; subject: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://email.test/")) {
    const b = JSON.parse(String(init?.body));
    mails.push({ to: b.to, subject: b.subject, body: b.body });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
  return realFetch(input, init);
}) as typeof fetch;
const lastLink = (): string => {
  const m = /https:\/\/admin\.test\/set-password\?token=([A-Za-z0-9_-]+)/.exec(mails[mails.length - 1]?.body ?? "");
  assert.ok(m, "no link in the last email");
  return m[1];
};

// ---- a client with a cookie jar per person --------------------------------------------
let base = "";
class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown) {
    const res = await realFetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b);
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b);
  put = (p: string, b?: unknown) => this.call("PUT", p, b);
  del = (p: string) => this.call("DELETE", p);
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let accountId = "";
const ZZ = "ZZTEST";
const made = { leads: [] as string[], customers: [] as string[] };

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/customer", express.json({ limit: "20kb" }));
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/auth", authRouter);
  app.use("/api/leads", requireAuth, leadsRouter);
  app.use("/api/integrations", requireAuth, integrationsRouter);
  app.use("/api/settings", requireAuth, settingsRouter);
  app.use("/api/team", requireAuth, requireOwner, teamRouter);
  app.use("/api/customer", customerRouter);
  app.use(((err: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "That request is too large." });
    res.status(500).json({ error: "Internal server error" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  globalThis.fetch = realFetch;
  const u = await prisma.adminUser.deleteMany({ where: { accountId } });
  const a = await prisma.adminAudit.deleteMany({ where: { accountId } });
  const s = await prisma.session.deleteMany({ where: { accountId } });
  const l = await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  const c = await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
  const f = await prisma.loginFailure.deleteMany({});
  const m = await prisma.messageLog.deleteMany({ where: { accountId } });
  const left = { users: await prisma.adminUser.count(), tokens: await prisma.adminToken.count(), audit: await prisma.adminAudit.count(), sessions: await prisma.session.count(), leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }), customers: await prisma.customer.count(), failures: await prisma.loginFailure.count() };
  console.log(`# cleanup: ${u.count} users (tokens cascade), ${a.count} audit rows, ${s.count} sessions, ${l.count} leads, ${c.count} customers, ${f.count} login failures, ${m.count} message logs; remaining ${JSON.stringify(left)}`);
  assert.deepEqual(left, { users: 0, tokens: 0, audit: 0, sessions: 0, leads: 0, customers: 0, failures: 0 });
  await prisma.$disconnect();
});

const owner = new Client();
const staff = new Client();
let staffId = "";
let secondOwnerId = "";

test("the shared login carries over: the first sign-in creates an Owner for info@thegoeventgroup.com", async () => {
  assert.equal(await prisma.adminUser.count({ where: { accountId } }), 0);
  const old = await owner.post("/api/auth/login", { password: "shared-login-password" });
  assert.equal(old.status, 200, "an older bundle sending only the password still gets in");
  assert.equal(old.body.user.email, BOOTSTRAP_EMAIL);
  assert.equal(old.body.user.role, "Owner");
  const users = await prisma.adminUser.findMany({ where: { accountId } });
  assert.equal(users.length, 1);
  assert.ok(users[0].passwordHash && !users[0].passwordHash.includes("shared-login"));
  const me = await owner.get("/api/auth/me");
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.name, "GO Event Group");
  // With the email, as the new login screen sends it.
  const again = await new Client().post("/api/auth/login", { email: " Info@TheGoEventGroup.com ", password: "shared-login-password" });
  assert.equal(again.status, 200);
});

test("a login never says whether an email exists", async () => {
  const unknown = await new Client().post("/api/auth/login", { email: "nobody@example.com", password: "whatever-password" });
  const wrong = await new Client().post("/api/auth/login", { email: BOOTSTRAP_EMAIL, password: "wrong-password" });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  const a = await new Client().post("/api/auth/forgot", { email: "nobody@example.com" });
  const b = await new Client().post("/api/auth/forgot", { email: BOOTSTRAP_EMAIL });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  await prisma.loginFailure.deleteMany({ where: { scope: "admin" } });
});

test("an invite: email with a single-use link, set the password, signed in as Staff; replay and expiry refused", async () => {
  const r = await owner.post("/api/team/invites", { name: "ZZTEST Sam", email: "sam@example.com", role: "Staff" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.invitePending, true);
  staffId = r.body.id;
  assert.equal(mails[mails.length - 1].to, "sam@example.com");
  const token = lastLink();
  assert.ok((await prisma.adminToken.findFirst({ where: { userId: staffId } }))!.tokenHash !== token, "only the hash is stored");
  const peek = await new Client().get(`/api/auth/token?token=${token}`);
  assert.equal(peek.status, 200);
  assert.deepEqual(peek.body, { kind: "invite", name: "ZZTEST Sam", email: "sam@example.com" });
  const short = await staff.post("/api/auth/set-password", { token, password: "short" });
  assert.equal(short.status, 400);
  const set = await staff.post("/api/auth/set-password", { token, password: "sam-password-123" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.user.role, "Staff");
  assert.equal((await staff.get("/api/auth/me")).body.user.email, "sam@example.com");
  const replay = await new Client().post("/api/auth/set-password", { token, password: "another-password-1" });
  assert.equal(replay.status, 400, "a spent link is refused");
  // An expired link.
  const expiredToken = "expired-token-expired-token-expired-token-1";
  await prisma.adminToken.create({ data: { userId: staffId, kind: "reset", tokenHash: createHash("sha256").update(expiredToken).digest("hex"), expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await new Client().get(`/api/auth/token?token=${expiredToken}`)).status, 404);
  assert.equal((await new Client().post("/api/auth/set-password", { token: expiredToken, password: "another-password-1" })).status, 400);
  await prisma.adminToken.deleteMany({ where: { userId: staffId } });
  // The team list no longer shows the invite pending.
  const team = await owner.get("/api/team");
  assert.equal(team.body.users.find((u: { id: string }) => u.id === staffId).invitePending, false);
});

test("roles on the API: Staff are refused on every business-critical route, allowed everywhere else", async () => {
  const refused = [
    staff.patch("/api/settings", { depositPercentage: 25 }),
    staff.patch("/api/settings", { staffNotifyEmail: "x@example.com", holdReleaseDays: 3 }),
    staff.post("/api/settings/policy", { text: "ZZTEST policy text" }),
    staff.post("/api/settings/contract-terms", { content: {} }),
    staff.put("/api/settings/contract-services", { rows: [] }),
    staff.patch("/api/integrations/google", { syncStage: "Signed" }),
    staff.post("/api/integrations/google/sync"),
    staff.post("/api/integrations/google/disconnect"),
    staff.get("/api/integrations/google/start"),
    staff.get("/api/team"),
    staff.post("/api/team/invites", { name: "x", email: "x@example.com", role: "Staff" }),
  ];
  for (const r of await Promise.all(refused)) {
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "Only owners can change this.");
  }
  assert.equal((await staff.get("/api/settings")).status, 200, "read is fine");
  assert.equal((await staff.get("/api/integrations/google")).status, 200);
  const notify = await staff.patch("/api/settings", { staffNotifyEmail: "zz-notify@example.com" });
  assert.equal(notify.status, 200, "the Notifications fields are Staff's");
  const ownerOk = await owner.patch("/api/settings", { staffNotifyEmail: null });
  assert.equal(ownerOk.status, 200);
  // Unauthenticated is 401, not 403.
  assert.equal((await new Client().get("/api/team")).status, 401);
});

test("settings changes and team actions are written down by name", async () => {
  const audit = await owner.get("/api/team/audit");
  assert.equal(audit.status, 200);
  const names = audit.body.map((a: { userName: string; action: string }) => `${a.userName}: ${a.action}`);
  assert.ok(names.includes("GO Event Group: invited"), names.join(" | "));
  assert.ok(names.includes("GO Event Group: settings changed"));
  assert.ok(names.includes("ZZTEST Sam: settings changed"), "Staff's own change carries their name");
});

test("lead activity records who wrote it", async () => {
  const status = (await prisma.leadStatus.findFirst({ where: { accountId } })) ?? (await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } }));
  const lead = await prisma.lead.create({ data: { accountId, status: status.name, source: "manual", customerName: `${ZZ} lead` } });
  made.leads.push(lead.id);
  const r = await staff.post(`/api/leads/${lead.id}/activity`, { text: "Called, left a message." });
  assert.equal(r.status, 201);
  assert.equal(r.body.userName, "ZZTEST Sam");
  assert.equal(r.body.userId, staffId);
  const list = await owner.get(`/api/leads/${lead.id}/activity`);
  assert.equal(list.body[0].userName, "ZZTEST Sam");
});

test("the last Owner cannot be demoted or removed; a second Owner can take over", async () => {
  const ownerId = (await prisma.adminUser.findFirstOrThrow({ where: { accountId, email: BOOTSTRAP_EMAIL } })).id;
  assert.equal((await owner.patch(`/api/team/${ownerId}`, { role: "Staff" })).status, 409);
  assert.equal((await owner.del(`/api/team/${ownerId}`)).status, 400, "not yourself");
  // Promote Sam to Owner: Sam is signed out everywhere by the change.
  const promote = await owner.patch(`/api/team/${staffId}`, { role: "Owner" });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.role, "Owner");
  assert.equal((await staff.get("/api/auth/me")).body.authenticated, false, "the role change ended Sam's session");
  const sam = new Client();
  assert.equal((await sam.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" })).status, 200);
  secondOwnerId = staffId;
  // Now the original can be demoted by Sam, and then Sam is the last Owner.
  assert.equal((await sam.patch(`/api/team/${ownerId}`, { role: "Staff" })).status, 200);
  assert.equal((await owner.get("/api/auth/me")).body.authenticated, false, "demoted: signed out");
  assert.equal((await sam.patch(`/api/team/${secondOwnerId}`, { role: "Staff" })).status, 409, "Sam is the last Owner now");
  // Put things back: Sam makes the original an Owner again and signs in again.
  assert.equal((await sam.patch(`/api/team/${ownerId}`, { role: "Owner" })).status, 200);
  assert.equal((await owner.post("/api/auth/login", { email: BOOTSTRAP_EMAIL, password: "shared-login-password" })).status, 200);
  assert.equal((await owner.patch(`/api/team/${secondOwnerId}`, { role: "Staff" })).status, 200);
  staff.cookie = "";
  assert.equal((await staff.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" })).status, 200);
});

test("two-step sign-in: setup, confirm, code at login, a backup code works once, turn off", async () => {
  const setup = await staff.post("/api/auth/two-step/setup");
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.ok(setup.body.qrSvg.startsWith("<svg"));
  assert.equal((await staff.post("/api/auth/two-step/confirm", { code: "000000" })).status, 400, "a wrong code does not turn it on");
  const confirm = await staff.post("/api/auth/two-step/confirm", { code: totp(setup.body.secret) });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.backupCodes.length, 8);
  const stored = await prisma.adminUser.findUniqueOrThrow({ where: { id: staffId } });
  assert.ok(stored.totpSecretEnc && !stored.totpSecretEnc.includes(setup.body.secret), "the secret is encrypted at rest");
  assert.ok(!stored.backupCodeHashes.includes(confirm.body.backupCodes[0]), "codes are hashed");
  assert.equal((await owner.get("/api/team")).body.users.find((u: { id: string }) => u.id === staffId).twoStep, true, "owners see it is on");
  // Login now needs the code.
  const c = new Client();
  const first = await c.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" });
  assert.deepEqual([first.status, first.body.twoStep], [200, true]);
  assert.equal((await c.get("/api/auth/me")).body.authenticated, false, "the password alone is not a session");
  assert.equal((await c.get("/api/settings")).status, 401);
  assert.equal((await c.post("/api/auth/two-step", { code: "123456" })).status, 401);
  const done = await c.post("/api/auth/two-step", { code: totp(setup.body.secret) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await c.get("/api/auth/me")).body.authenticated, true);
  // A backup code, once.
  const b = new Client();
  await b.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" });
  assert.equal((await b.post("/api/auth/two-step", { code: confirm.body.backupCodes[0] })).status, 200);
  const b2 = new Client();
  await b2.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" });
  assert.equal((await b2.post("/api/auth/two-step", { code: confirm.body.backupCodes[0] })).status, 401, "spent");
  assert.equal((await b2.post("/api/auth/two-step", { code: confirm.body.backupCodes[1] })).status, 200);
  await prisma.loginFailure.deleteMany({ where: { scope: "admin-2fa" } });
  // Off again, with the password.
  assert.equal((await c.post("/api/auth/two-step/disable", { password: "nope-nope-nope" })).status, 400);
  assert.equal((await c.post("/api/auth/two-step/disable", { password: "sam-password-123" })).status, 200);
  const plain = new Client();
  assert.equal((await plain.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" })).body.twoStep, false);
});

test("password reset by email: the link is single use and signs out the old sessions", async () => {
  const before = mails.length;
  assert.equal((await new Client().post("/api/auth/forgot", { email: "sam@example.com" })).status, 200);
  assert.equal(mails.length, before + 1);
  assert.match(mails[mails.length - 1].subject, /Reset/);
  const token = lastLink();
  const fresh = new Client();
  assert.equal((await fresh.post("/api/auth/set-password", { token, password: "sam-new-password-1" })).status, 200);
  assert.equal((await staff.get("/api/auth/me")).body.authenticated, false, "the earlier session is gone");
  assert.equal((await new Client().post("/api/auth/login", { email: "sam@example.com", password: "sam-password-123" })).status, 401);
  staff.cookie = "";
  assert.equal((await staff.post("/api/auth/login", { email: "sam@example.com", password: "sam-new-password-1" })).status, 200);
  assert.equal((await new Client().post("/api/auth/set-password", { token, password: "sam-new-password-2" })).status, 400, "spent");
  await prisma.loginFailure.deleteMany({ where: { scope: "admin" } });
  // Change password while signed in needs the current one.
  assert.equal((await staff.post("/api/auth/password", { current: "wrong", next: "sam-new-password-2" })).status, 400);
  assert.equal((await staff.post("/api/auth/password", { current: "sam-new-password-1", next: "sam-new-password-2" })).status, 200);
});

test("resend and revoke invites; revoking someone who never signed in deletes the row", async () => {
  const r = await owner.post("/api/team/invites", { name: "ZZTEST Pat", email: "pat@example.com", role: "Owner" });
  assert.equal(r.status, 201);
  const first = lastLink();
  assert.equal((await owner.post(`/api/team/${r.body.id}/resend-invite`)).status, 200);
  const second = lastLink();
  assert.notEqual(first, second);
  assert.equal((await new Client().get(`/api/auth/token?token=${first}`)).status, 404, "the earlier link died with the resend");
  assert.equal((await owner.post("/api/team/invites", { name: "x", email: "pat@example.com", role: "Staff" })).status, 409, "already invited");
  assert.equal((await owner.post(`/api/team/${r.body.id}/revoke-invite`)).status, 200);
  assert.equal(await prisma.adminUser.count({ where: { id: r.body.id } }), 0);
  assert.equal((await new Client().get(`/api/auth/token?token=${second}`)).status, 404);
  assert.equal((await owner.post(`/api/team/${staffId}/resend-invite`)).status, 400, "Sam has a password: no invite to resend");
});

test("removing a person signs them out everywhere at once and keeps their name on the records", async () => {
  const other = new Client();
  assert.equal((await other.post("/api/auth/login", { email: "sam@example.com", password: "sam-new-password-2" })).status, 200);
  assert.ok((await prisma.session.count({ where: { userId: staffId } })) >= 2, "signed in on more than one device");
  assert.equal((await owner.del(`/api/team/${staffId}`)).status, 200);
  assert.equal(await prisma.session.count({ where: { userId: staffId } }), 0);
  assert.equal((await staff.get("/api/auth/me")).body.authenticated, false);
  assert.equal((await other.get("/api/settings")).status, 401);
  assert.equal((await new Client().post("/api/auth/login", { email: "sam@example.com", password: "sam-new-password-2" })).status, 401);
  assert.equal((await owner.get("/api/team")).body.users.some((u: { id: string }) => u.id === staffId), false);
  const activity = await prisma.leadActivity.findFirst({ where: { userId: staffId } });
  assert.equal(activity?.userName, "ZZTEST Sam");
  await prisma.loginFailure.deleteMany({ where: { scope: "admin" } });
});

test("the customer login lockout lives in the database", async () => {
  const c = await prisma.customer.create({ data: { accountId, name: `${ZZ} Customer`, phone: "15005550199", email: "zzcustomer@example.com", passwordHash: "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid" } });
  made.customers.push(c.id);
  for (let i = 0; i < 5; i++) assert.equal((await new Client().post("/api/customer/login", { identifier: "zzcustomer@example.com", password: "wrong-password" })).status, 401);
  assert.equal(await prisma.loginFailure.count({ where: { scope: "customer" } }), 5, "every failure is a row, so a deploy keeps the count");
  const sixth = await new Client().post("/api/customer/login", { identifier: "zzcustomer@example.com", password: "wrong-password" });
  assert.equal(sixth.status, 429);
  assert.equal(await prisma.loginFailure.count({ where: { scope: "customer" } }), 5, "a refused attempt does not extend the lockout");
});

test("an oversized body is refused before the session check", async () => {
  const big = { customerName: "x".repeat(70_000) };
  const r = await new Client().post("/api/leads", big);
  assert.equal(r.status, 413, "413, not 401");
  const small = await new Client().post("/api/leads", { customerName: "x" });
  assert.equal(small.status, 401);
});
