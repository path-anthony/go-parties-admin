// Block A7, over HTTP on a throwaway database: the customer-facing item
// description saves and comes back, blank clears it, over the limit is
// refused, and every public shape that carries items carries it (the
// catalog, the packages feed and the shape Ask GO returns). Every row made
// here is deleted at the end.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { prisma } from "../db.js";
import { toPublicItem } from "../publicItem.js";
import itemsRouter, { MAX_DESCRIPTION_LENGTH } from "../routes/items.js";
import publicItemsRouter from "../routes/publicItems.js";
import publicPackagesRouter, { clearPublicPackagesCache } from "../routes/publicPackages.js";
import { catalogLine } from "../routes/recommend.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("itemDescription.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], packages: [] as string[] };

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/items", publicItemsRouter);
  app.use("/api/items", (_req, _res, next) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next()), itemsRouter);
  app.use("/api/packages", publicPackagesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const p = await prisma.package.deleteMany({ where: { id: { in: made.packages } } });
  const i = await prisma.item.deleteMany({ where: { id: { in: made.items } } });
  const left = await prisma.item.count({ where: { name: { startsWith: ZZ } } });
  console.log(`# cleanup: ${p.count} packages, ${i.count} items; remaining ${left}`);
  await prisma.$disconnect();
});

const json = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json" } });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const post = (path: string, body: unknown) => json(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => json(path, { method: "PATCH", body: JSON.stringify(body) });

test("the description saves on create and on edit, is trimmed, and blank clears it", async () => {
  const created = await post("/api/items", { name: `${ZZ} Snow Cone Cart`, category: "Fun Foods", price: 150, priceUnit: "per event", notes: "supplier: Frosty Co, cost $40", description: "  Shaved ice with six syrups. Serves 50. " });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  made.items.push(created.json.id as string);
  assert.equal(created.json.description, "Shaved ice with six syrups. Serves 50.");

  let r = await patch(`/api/items/${created.json.id}`, { description: "Shaved ice, six syrups, a cart and an attendant for two hours." });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, "Shaved ice, six syrups, a cart and an attendant for two hours.");
  r = await patch(`/api/items/${created.json.id}`, { description: "" });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, null, "blank clears it");
  r = await patch(`/api/items/${created.json.id}`, { description: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, null);
  r = await patch(`/api/items/${created.json.id}`, { description: "Back on." });
  assert.equal(r.json.description, "Back on.");
  const row = await prisma.item.findUniqueOrThrow({ where: { id: created.json.id as string } });
  assert.equal(row.notes, "supplier: Frosty Co, cost $40", "notes are untouched");

  const without = await post("/api/items", { name: `${ZZ} Plain Table`, category: "Venue Essentials", price: 10, priceUnit: "per day" });
  assert.equal(without.status, 201);
  made.items.push(without.json.id as string);
  assert.equal(without.json.description, null);
});

test("over the limit, or not text, is refused on create and on edit", async () => {
  const long = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
  let r = await post("/api/items", { name: `${ZZ} Too Long`, category: "Games", price: 1, priceUnit: "per day", description: long });
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /240/);
  r = await patch(`/api/items/${made.items[0]}`, { description: long });
  assert.equal(r.status, 400);
  r = await patch(`/api/items/${made.items[0]}`, { description: 12 });
  assert.equal(r.status, 400);
  const exact = "y".repeat(MAX_DESCRIPTION_LENGTH);
  r = await patch(`/api/items/${made.items[0]}`, { description: exact });
  assert.equal(r.status, 200, "exactly the limit is fine");
  assert.equal(r.json.description, exact);
  r = await patch(`/api/items/${made.items[0]}`, { description: "Shaved ice with six syrups." });
  assert.equal(r.status, 200);
});

test("the public catalog, the packages feed and the Ask GO item shape carry it, null when empty, and notes never leave", async () => {
  const cat = await json("/api/items/public");
  assert.equal(cat.status, 200);
  const items = cat.json.items as Record<string, unknown>[];
  const cart = items.find((i) => i.id === made.items[0]) as Record<string, unknown>;
  const table = items.find((i) => i.id === made.items[1]) as Record<string, unknown>;
  assert.equal(cart.description, "Shaved ice with six syrups.");
  assert.equal(table.description, null);
  assert.equal("notes" in cart, false);

  const pkg = await prisma.package.create({ data: { accountId, name: `${ZZ} Cone Party`, status: "Published", occasions: ["Birthday"], price: 500, items: { create: [{ itemId: made.items[0], quantity: 1 }, { itemId: made.items[1], quantity: 2 }] } } });
  made.packages.push(pkg.id);
  clearPublicPackagesCache();
  const feed = await json("/api/packages/public?occasion=Birthday");
  const mine = (feed.json.packages as Record<string, unknown>[]).find((p) => p.id === pkg.id) as { items: Record<string, unknown>[] };
  const byId = Object.fromEntries(mine.items.map((i) => [i.itemId, i]));
  assert.equal(byId[made.items[0]].description, "Shaved ice with six syrups.");
  assert.equal(byId[made.items[1]].description, null);
  assert.equal("notes" in byId[made.items[0]], false);

  // Ask GO answers with toPublicItem and shows the model catalogLine; both carry it, neither carries notes.
  const row = await prisma.item.findUniqueOrThrow({ where: { id: made.items[0] }, include: { _count: { select: { units: true } }, addonGroups: { include: { addons: true } } } });
  const pub = toPublicItem(row);
  assert.equal(pub.description, "Shaved ice with six syrups.");
  assert.equal("notes" in pub, false);
  const line = catalogLine(row);
  assert.match(line, /about: Shaved ice with six syrups\./);
  assert.doesNotMatch(line, /Frosty/);
});
