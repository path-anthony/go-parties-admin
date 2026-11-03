// Block A6, over HTTP on a throwaway database: upload (resize to WebP,
// thumbnail), the refusals (not a photo, wrong type, over 15 MB, HEIC this
// server cannot decode), the public list in order with only active slides,
// the image route and its cache header, move, hide, delete, and the seed.
// Every row made here is deleted at the end with a count.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.NODE_ENV = "test";
process.env.PUBLIC_API_URL = "https://api.test";

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import sharp from "sharp";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { prisma } from "../db.js";
import { MAX_UPLOAD_BYTES, MAX_WIDTH, THUMB_WIDTH } from "../hero.js";
import { seedHeroSlides } from "../heroSeed.js";
import { heroAdminRouter, publicHeroRouter, publicMediaRouter } from "../routes/hero.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("hero.test.ts runs only against a throwaway database (name containing zz_scratch)");

let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let slidesBefore = 0;

before(async () => {
  accountId = (await getDefaultAccount()).id;
  slidesBefore = await prisma.heroSlide.count({ where: { accountId } });
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/hero", publicHeroRouter);
  app.use("/api/media", publicMediaRouter);
  app.use("/api/hero", (_req, _res, next) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next()), heroAdminRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const gone = await prisma.heroSlide.deleteMany({ where: { accountId } });
  console.log(`# cleanup: ${gone.count} hero slides (${slidesBefore} were there before the run); remaining ${await prisma.heroSlide.count({ where: { accountId } })}`);
  await prisma.$disconnect();
});

type Slide = { id: string; altText: string; width: number; height: number; sortOrder: number; active: boolean; url: string; thumbnailUrl: string };
const photo = (w: number, h: number, format: "jpeg" | "png" = "jpeg") => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } })[format]().toBuffer();
async function upload(bytes: Uint8Array, type: string, name = "photo.jpg") {
  const r = await fetch(`${base}/api/hero?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": type }, body: bytes });
  return { status: r.status, json: (await r.json()) as Slide & { error?: string } };
}
const json = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { status: r.status, json: (await r.json()) as unknown, headers: r.headers };
};
const ids: string[] = [];

test("an upload is resized to WebP, no wider than the limit, with a thumbnail; a small one is not enlarged", async () => {
  const big = await upload(await photo(3000, 2000), "image/jpeg", "wide-beach-party.jpg");
  assert.equal(big.status, 201, JSON.stringify(big.json));
  assert.equal(big.json.width, MAX_WIDTH);
  assert.equal(big.json.height, 1333);
  assert.equal(big.json.altText, "wide beach party", "the file name seeds the alt text");
  assert.equal(big.json.url, `https://api.test/api/media/hero/${big.json.id}`);
  ids.push(big.json.id);
  const row = await prisma.heroSlide.findUniqueOrThrow({ where: { id: big.json.id } });
  assert.equal(row.mimeType, "image/webp");
  const stored = await sharp(Buffer.from(row.imageData)).metadata();
  assert.equal(stored.format, "webp");
  assert.equal(stored.width, MAX_WIDTH);
  const thumb = await sharp(Buffer.from(row.thumbData)).metadata();
  assert.equal(thumb.format, "webp");
  assert.equal(thumb.width, THUMB_WIDTH);
  assert.ok(row.imageData.length < 3000 * 2000, "stored smaller than raw pixels");

  const small = await upload(await photo(1200, 800, "png"), "image/png", "small.png");
  assert.equal(small.status, 201);
  assert.deepEqual([small.json.width, small.json.height], [1200, 800]);
  ids.push(small.json.id);
  const third = await upload(await photo(1600, 900), "image/jpeg", "third.jpg");
  assert.equal(third.status, 201);
  ids.push(third.json.id);
  assert.deepEqual(ids.map((_, i) => i), [0, 1, 2]);
  const list = (await json("/api/hero/admin")).json as Slide[];
  assert.deepEqual(list.map((s) => s.id), ids, "listed in upload order");
  assert.deepEqual(list.map((s) => s.sortOrder), [0, 1, 2]);
});

test("not a photo, a wrong type, an oversize file and an unreadable HEIC are refused with a plain sentence", async () => {
  const text = await upload(new TextEncoder().encode("hello, not a photo"), "image/jpeg", "fake.jpg");
  assert.equal(text.status, 400);
  assert.match(text.json.error ?? "", /isn't a photo we can read/);
  const pdf = await upload(await photo(100, 100), "application/pdf", "doc.pdf");
  assert.equal(pdf.status, 400);
  assert.match(pdf.json.error ?? "", /not accepted/);
  const over = await upload(new Uint8Array(MAX_UPLOAD_BYTES + 1), "image/png", "huge.png");
  assert.equal(over.status, 400);
  assert.match(over.json.error ?? "", /over 15 MB/);
  const wayOver = await fetch(`${base}/api/hero?name=giant.png`, { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array(MAX_UPLOAD_BYTES + 4096) });
  assert.equal(wayOver.status, 400, "past the parser limit is the same refusal");
  const heic = await upload(new TextEncoder().encode("ftypheic but not really"), "image/heic", "phone.heic");
  assert.equal(heic.status, 400);
  assert.match(heic.json.error ?? "", /HEIC|isn't a photo/);
  assert.equal((await prisma.heroSlide.count({ where: { accountId } })) - slidesBefore, 3, "nothing was stored");
});

test("the public list has only active slides in order, and the image route is cached for a year", async () => {
  const pub = await json("/api/hero");
  assert.equal(pub.status, 200);
  const list = pub.json as { id: string; url: string; altText: string; width: number; height: number }[];
  assert.deepEqual(list.map((s) => s.id), ids);
  assert.deepEqual(Object.keys(list[0]).sort(), ["altText", "height", "id", "url", "width"], "nothing internal");
  const img = await fetch(`${base}/api/media/hero/${ids[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/webp");
  assert.equal(img.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await sharp(Buffer.from(await img.arrayBuffer())).metadata()).width, MAX_WIDTH);
  const missing = await fetch(`${base}/api/media/hero/nope`);
  assert.equal(missing.status, 404);
});

test("move, hide, alt text and delete", async () => {
  let r = await json(`/api/hero/${ids[2]}/move`, { method: "POST", body: JSON.stringify({ direction: "up" }) });
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as Slide[]).map((s) => s.id), [ids[0], ids[2], ids[1]]);
  r = await json(`/api/hero/${ids[0]}/move`, { method: "POST", body: JSON.stringify({ direction: "up" }) });
  assert.deepEqual((r.json as Slide[]).map((s) => s.id), [ids[0], ids[2], ids[1]], "the first cannot move up");
  r = await json(`/api/hero/${ids[0]}/move`, { method: "POST", body: JSON.stringify({ direction: "sideways" }) });
  assert.equal(r.status, 400);

  r = await json(`/api/hero/${ids[2]}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
  assert.equal(r.status, 200);
  const pub = (await json("/api/hero")).json as { id: string }[];
  assert.deepEqual(pub.map((s) => s.id), [ids[0], ids[1]], "hidden slides leave the public list, order kept");
  assert.equal((await fetch(`${base}/api/media/hero/${ids[2]}`)).status, 200, "the image itself still answers");

  r = await json(`/api/hero/${ids[1]}`, { method: "PATCH", body: JSON.stringify({ altText: "  Dance floor at a wedding  " }) });
  assert.equal(r.status, 200);
  assert.equal((r.json as Slide[]).find((s) => s.id === ids[1])?.altText, "Dance floor at a wedding");
  r = await json(`/api/hero/${ids[1]}`, { method: "PATCH", body: JSON.stringify({ altText: "   " }) });
  assert.equal(r.status, 400, "alt text is required");
  r = await json(`/api/hero/${ids[1]}`, { method: "PATCH", body: JSON.stringify({}) });
  assert.equal(r.status, 400);

  r = await json(`/api/hero/${ids[1]}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as Slide[]).map((s) => s.id), [ids[0], ids[2]]);
  assert.equal((await fetch(`${base}/api/media/hero/${ids[1]}`)).status, 404, "a deleted slide's image is gone");
  r = await json(`/api/hero/${ids[1]}`, { method: "DELETE" });
  assert.equal(r.status, 404);
});

test("the seed imports the three photos when the folder is there, skips when it is not, and never runs twice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zz-hero-"));
  try {
    for (const f of ["wedding.jpg", "adult-party.jpg"]) await writeFile(path.join(dir, f), await photo(1200, 798));
    assert.match(await seedHeroSlides(prisma, accountId, dir), /^Home photos: 2 already there, nothing imported/);
    await prisma.heroSlide.deleteMany({ where: { accountId } });
    const msg = await seedHeroSlides(prisma, accountId, dir);
    assert.equal(msg, `Home photos: imported 2 from ${dir} (not found: corporate.jpg)`);
    const rows = await prisma.heroSlide.findMany({ where: { accountId }, orderBy: { sortOrder: "asc" } });
    assert.deepEqual(rows.map((r) => [r.altText.split(" ")[0], r.width, r.mimeType, r.active]), [["Wedding", 1200, "image/webp", true], ["Adult", 1200, "image/webp", true]]);
    await prisma.heroSlide.deleteMany({ where: { accountId } });
    assert.match(await seedHeroSlides(prisma, accountId, path.join(dir, "missing")), /^Home photos: none imported/);
    assert.equal(await prisma.heroSlide.count({ where: { accountId } }), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
