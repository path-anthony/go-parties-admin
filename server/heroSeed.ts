import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { processHeroImage } from "./hero.js";

// Block A6: the first slides, imported from the storefront repo's hero
// photos on this machine so the live Home page has photos on day one.
// Runs only when the account has no slides at all; skips, and says so,
// when the folder is not there.
export const DEFAULT_HERO_DIR = path.join(homedir(), "go-parties-app", "public", "photos", "welcome");
export const SEED_PHOTOS = [
  { file: "wedding.jpg", altText: "Wedding reception set up by GO Event Group" },
  { file: "adult-party.jpg", altText: "Adult party with GO Event Group lighting and sound" },
  { file: "corporate.jpg", altText: "Corporate event staged by GO Event Group" },
] as const;

export async function seedHeroSlides(prisma: PrismaClient, accountId: string, dir: string = process.env.HERO_SEED_DIR ?? DEFAULT_HERO_DIR): Promise<string> {
  const existing = await prisma.heroSlide.count({ where: { accountId } });
  if (existing > 0) return `Home photos: ${existing} already there, nothing imported`;
  let added = 0;
  const missing: string[] = [];
  for (const [i, photo] of SEED_PHOTOS.entries()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dir, photo.file));
    } catch {
      missing.push(photo.file);
      continue;
    }
    const p = await processHeroImage(bytes, "image/jpeg");
    await prisma.heroSlide.create({ data: { accountId, imageData: p.image, thumbData: p.thumb, mimeType: p.mimeType, width: p.width, height: p.height, altText: photo.altText, sortOrder: i } });
    added += 1;
  }
  if (added === 0) return `Home photos: none imported, ${dir} has none of ${SEED_PHOTOS.map((p) => p.file).join(", ")}`;
  return `Home photos: imported ${added} from ${dir}${missing.length ? ` (not found: ${missing.join(", ")})` : ""}`;
}
