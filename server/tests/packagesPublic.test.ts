// Block A2, over HTTP on a throwaway database: the public packages feed
// with and without an occasion, the tag and guest note on the way in and
// out, and the one-minute cache. Every row made here is deleted at the end.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { runAsActor } from "../actor.js";
import packagesRouter, { MAX_GUEST_NOTE_LENGTH, MAX_TAG_LENGTH } from "../routes/packages.js";
import publicPackagesRouter, { clearPublicPackagesCache } from "../routes/publicPackages.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("packagesPublic.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], packages: [] as string[] };

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const item = await prisma.item.create({ data: { accountId, name: `${ZZ} Cotton Candy`, category: "Food", price: 150, priceUnit: "per event" } });
  made.items.push(item.id);
  const mk = async (name: string, status: string, occasions: string[], extra: Record<string, unknown> = {}) => {
    const p = await prisma.package.create({ data: { accountId, name, status, occasions, price: 999, items: { create: [{ itemId: item.id, quantity: 2 }] }, ...extra } });
    made.packages.push(p.id);
    return p.id;
  };
  await mk(`${ZZ} Kids Bash`, "Published", ["Birthday"], { tag: "Most booked", guestNote: "Up to 25 kids" });
  await mk(`${ZZ} Reception Set`, "Published", ["Reception only", "Ceremony + reception"]);
  await mk(`${ZZ} Draft Only`, "Draft", ["Birthday"], { tag: "Hidden" });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/packages", publicPackagesRouter);
  // The admin router behind a stand-in for the session: an Owner actor.
  app.use("/api/packages", (_req, _res, next) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next()), packagesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  clearPublicPackagesCache();
});

after(async () => {
  server?.close();
  const p = await prisma.package.deleteMany({ where: { id: { in: made.packages } } });
  const i = await prisma.item.deleteMany({ where: { id: { in: made.items } } });
  const left = await prisma.package.count({ where: { name: { startsWith: ZZ } } });
  console.log(`# cleanup: ${p.count} packages, ${i.count} items; remaining ${left}`);
  await prisma.$disconnect();
});

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, json: (await r.json()) as { occasion: string | null; packages: Record<string, unknown>[] } };
};
const mine = (rows: Record<string, unknown>[]) => rows.filter((p) => String(p.name).startsWith(ZZ));

test("no occasion: every published package, none unpublished, with its occasions, groups, tag and guest note", async () => {
  clearPublicPackagesCache();
  const r = await get("/api/packages/public");
  assert.equal(r.status, 200);
  assert.equal(r.json.occasion, null);
  const rows = mine(r.json.packages);
  assert.deepEqual(rows.map((p) => p.name).sort(), [`${ZZ} Kids Bash`, `${ZZ} Reception Set`]);
  const kids = rows.find((p) => p.name === `${ZZ} Kids Bash`) as Record<string, unknown>;
  assert.deepEqual(kids.occasions, ["Birthday"]);
  assert.ok((kids.groups as string[]).includes("Kids party"), `groups: ${JSON.stringify(kids.groups)}`);
  assert.equal(kids.occasion, (kids.groups as string[])[0]);
  assert.equal(kids.tag, "Most booked");
  assert.equal(kids.guestNote, "Up to 25 kids");
  assert.equal(kids.price, 999);
  assert.equal((kids.items as { quantity: number; itemId: string }[])[0].quantity, 2);
  const reception = rows.find((p) => p.name === `${ZZ} Reception Set`) as Record<string, unknown>;
  assert.deepEqual(reception.groups, ["Wedding"]);
  assert.equal(reception.tag, null);
  assert.equal(reception.guestNote, null);
});

test("with an occasion: the same shape as before, only that occasion's packages, the new fields included", async () => {
  const r = await get("/api/packages/public?occasion=Birthday");
  assert.equal(r.json.occasion, "Birthday");
  const rows = mine(r.json.packages);
  assert.deepEqual(rows.map((p) => p.name), [`${ZZ} Kids Bash`]);
  assert.equal(rows[0].occasion, "Birthday");
  assert.equal(rows[0].tag, "Most booked");
  const none = await get(`/api/packages/public?occasion=${encodeURIComponent("Reception only")}`);
  assert.deepEqual(mine(none.json.packages).map((p) => p.name), [`${ZZ} Reception Set`]);
});

test("the no-occasion answer is cached for a minute and dropped by an admin write", async () => {
  clearPublicPackagesCache();
  await get("/api/packages/public");
  const id = made.packages[0];
  await prisma.package.update({ where: { id }, data: { tag: "Changed under the cache" } });
  const stale = await get("/api/packages/public");
  assert.equal(mine(stale.json.packages).find((p) => p.name === `${ZZ} Kids Bash`)?.tag, "Most booked", "served from the cache");
  const r = await fetch(`${base}/api/packages/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "Staff pick" }) });
  assert.equal(r.status, 200);
  const fresh = await get("/api/packages/public");
  assert.equal(mine(fresh.json.packages).find((p) => p.name === `${ZZ} Kids Bash`)?.tag, "Staff pick", "the write dropped the cache");
  const byOccasion = await get("/api/packages/public?occasion=Birthday");
  assert.equal(mine(byOccasion.json.packages)[0].tag, "Staff pick", "the occasion call is never cached");
});

test("the fields save through the admin, within their limits, and blank clears them", async () => {
  const id = made.packages[1];
  const patch = (body: unknown) => fetch(`${base}/api/packages/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let r = await patch({ tag: " Weekend deal ", guestNote: "Up to 120 guests" });
  assert.equal(r.status, 200);
  const saved = (await r.json()) as { tag: string | null; guestNote: string | null };
  assert.equal(saved.tag, "Weekend deal");
  assert.equal(saved.guestNote, "Up to 120 guests");
  r = await patch({ tag: "x".repeat(MAX_TAG_LENGTH + 1) });
  assert.equal(r.status, 400);
  r = await patch({ guestNote: "y".repeat(MAX_GUEST_NOTE_LENGTH + 1) });
  assert.equal(r.status, 400);
  r = await patch({ tag: 12 });
  assert.equal(r.status, 400);
  r = await patch({ tag: "", guestNote: null });
  assert.equal(r.status, 200);
  const cleared = (await r.json()) as { tag: string | null; guestNote: string | null };
  assert.equal(cleared.tag, null);
  assert.equal(cleared.guestNote, null);
  const pub = await get(`/api/packages/public?occasion=${encodeURIComponent("Reception only")}`);
  assert.equal(mine(pub.json.packages)[0].tag, null);
  const created = await fetch(`${base}/api/packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${ZZ} New One`, price: 10, tag: "Fresh", guestNote: "Up to 10", items: [{ itemId: made.items[0], quantity: 1 }] }) });
  assert.equal(created.status, 201);
  const c = (await created.json()) as { id: string; tag: string; guestNote: string };
  made.packages.push(c.id);
  assert.equal(c.tag, "Fresh");
  assert.equal(c.guestNote, "Up to 10");
});
