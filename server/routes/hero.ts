import express, { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { HeroImageError, MAX_ALT_LENGTH, MAX_UPLOAD_BYTES, altFromFileName, heroImageUrl, processHeroImage } from "../hero.js";
import { availabilityLimiter } from "../rateLimit.js";
import { safeInline } from "../sanitize.js";
import { audit } from "../users.js";

// Block A6: the Home page photo rotation.
//
// Public, no session: GET /api/hero lists the active slides in order and
// GET /api/media/hero/:id serves one image. A slide's bytes never change
// under its id (there is no replace; a new photo is a new slide), so the
// image answer is cached for a year and marked immutable. Both sit behind
// the read-only public limiter and are built field by field.
//
// Admin, behind the session: the list with thumbnails, upload (several
// files are several requests), alt text, show or hide, move, delete.

const ONE_YEAR = "public, max-age=31536000, immutable";

export const publicHeroRouter = Router();

publicHeroRouter.get("/", availabilityLimiter, async (_req, res) => {
  const account = await getDefaultAccount();
  const slides = await prisma.heroSlide.findMany({
    where: { accountId: account.id, active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, altText: true, width: true, height: true },
  });
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(slides.map((s) => ({ id: s.id, url: heroImageUrl(s.id), altText: s.altText, width: s.width, height: s.height })));
});

export const publicMediaRouter = Router();

publicMediaRouter.get("/hero/:id", availabilityLimiter, async (req, res) => {
  const id = String(req.params.id);
  const slide = await prisma.heroSlide.findUnique({ where: { id }, select: { imageData: true, mimeType: true } });
  if (!slide) return res.status(404).json({ error: "No such photo" });
  res.setHeader("Content-Type", slide.mimeType);
  res.setHeader("Cache-Control", ONE_YEAR);
  res.setHeader("ETag", `"${id}"`);
  res.send(Buffer.from(slide.imageData));
});

// ---- admin ---------------------------------------------------------------------

const ADMIN_SELECT = { id: true, altText: true, width: true, height: true, sortOrder: true, active: true, createdAt: true } as const;

async function adminList(accountId: string) {
  const slides = await prisma.heroSlide.findMany({ where: { accountId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: ADMIN_SELECT });
  return slides.map((s) => ({ ...s, url: heroImageUrl(s.id), thumbnailUrl: `/api/hero/admin/${s.id}/thumbnail` }));
}

export const heroAdminRouter = Router();

heroAdminRouter.get("/admin", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json(await adminList(account.id));
});

heroAdminRouter.get("/admin/:id/thumbnail", async (req, res) => {
  const account = await getDefaultAccount();
  const slide = await prisma.heroSlide.findFirst({ where: { id: req.params.id, accountId: account.id }, select: { thumbData: true, mimeType: true } });
  if (!slide) return res.status(404).json({ error: "No such photo" });
  res.setHeader("Content-Type", slide.mimeType);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(Buffer.from(slide.thumbData));
});

// One photo per request, as the raw bytes with its Content-Type. The file
// name (?name=) seeds the alt text; the admin edits it in the list.
const rawImage = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 });
heroAdminRouter.post("/", (req, res, next) => {
  rawImage(req, res, (err?: unknown) => {
    if (err) return res.status(400).json({ error: "That photo is over 15 MB. Export a smaller copy and try again." });
    next();
  });
}, async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let processed;
  try {
    processed = await processHeroImage(bytes, req.get("content-type"));
  } catch (err) {
    if (err instanceof HeroImageError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const altText = safeInline(altFromFileName(req.query.name), MAX_ALT_LENGTH) || "Party photo";
  const account = await getDefaultAccount();
  const last = await prisma.heroSlide.aggregate({ where: { accountId: account.id }, _max: { sortOrder: true } });
  const slide = await prisma.heroSlide.create({
    data: { accountId: account.id, imageData: processed.image, thumbData: processed.thumb, mimeType: processed.mimeType, width: processed.width, height: processed.height, altText, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    select: ADMIN_SELECT,
  });
  await audit("home photo added", slide.id);
  res.status(201).json({ ...slide, url: heroImageUrl(slide.id), thumbnailUrl: `/api/hero/admin/${slide.id}/thumbnail` });
});

heroAdminRouter.patch("/:id", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { altText?: string; active?: boolean } = {};
  if ("altText" in body) {
    const raw = typeof body.altText === "string" ? body.altText.trim() : "";
    if (raw.length > MAX_ALT_LENGTH) return res.status(400).json({ error: `Alt text must be ${MAX_ALT_LENGTH} characters or fewer.` });
    const text = safeInline(raw, MAX_ALT_LENGTH);
    if (!text) return res.status(400).json({ error: "Alt text is required: a short description of the photo." });
    data.altText = text;
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
    data.active = body.active;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "Send altText or active" });
  const account = await getDefaultAccount();
  const updated = await prisma.heroSlide.updateMany({ where: { id: req.params.id, accountId: account.id }, data });
  if (updated.count === 0) return res.status(404).json({ error: "No such photo" });
  await audit("home photo changed", `${req.params.id}: ${Object.keys(data).join(", ")}`);
  res.json(await adminList(account.id));
});

// Move one step: swap sort orders with the neighbour. The list is read and
// written in one transaction so two clicks at once cannot cross.
heroAdminRouter.post("/:id/move", async (req, res) => {
  const direction = (req.body ?? {}).direction;
  if (direction !== "up" && direction !== "down") return res.status(400).json({ error: "direction must be up or down" });
  const account = await getDefaultAccount();
  const ok = await prisma.$transaction(async (tx) => {
    const slides = await tx.heroSlide.findMany({ where: { accountId: account.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const i = slides.findIndex((s) => s.id === req.params.id);
    if (i === -1) return "missing";
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= slides.length) return "edge";
    // Renumber the whole list so any gaps or ties from deletes disappear.
    const order = slides.map((s) => s.id);
    [order[i], order[j]] = [order[j], order[i]];
    for (let k = 0; k < order.length; k += 1) await tx.heroSlide.update({ where: { id: order[k] }, data: { sortOrder: k } });
    return "moved";
  });
  if (ok === "missing") return res.status(404).json({ error: "No such photo" });
  await audit("home photo moved", `${req.params.id} ${direction}`);
  res.json(await adminList(account.id));
});

heroAdminRouter.delete("/:id", async (req, res) => {
  const account = await getDefaultAccount();
  const gone = await prisma.heroSlide.deleteMany({ where: { id: req.params.id, accountId: account.id } });
  if (gone.count === 0) return res.status(404).json({ error: "No such photo" });
  await audit("home photo deleted", req.params.id);
  res.json(await adminList(account.id));
});
