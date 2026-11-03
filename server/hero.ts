import sharp, { type Metadata } from "sharp";

// Block A6: the Home page photo rotation. One place turns an upload into
// what is stored: the full image as WebP at most MAX_WIDTH wide, and a
// THUMB_WIDTH thumbnail for the admin list. Nothing here touches the
// database; the routes and the seed both call processHeroImage.

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_WIDTH = 2000;
export const THUMB_WIDTH = 400;
export const WEBP_QUALITY = 78;
export const MAX_ALT_LENGTH = 200;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const ACCEPTED_TYPES_SENTENCE = "Upload a JPEG, PNG, WebP or HEIC photo.";

export class HeroImageError extends Error {}

export function acceptedType(mime: string | undefined): mime is (typeof ACCEPTED_TYPES)[number] {
  return typeof mime === "string" && (ACCEPTED_TYPES as readonly string[]).includes(mime.split(";")[0].trim().toLowerCase());
}

export type ProcessedHero = { image: Uint8Array<ArrayBuffer>; thumb: Uint8Array<ArrayBuffer>; width: number; height: number; mimeType: "image/webp" };

// Throws HeroImageError with a sentence a person can read when the bytes
// are too big, not a photo, or a HEIC this server cannot decode.
export async function processHeroImage(bytes: Buffer, mime: string | undefined): Promise<ProcessedHero> {
  if (!acceptedType(mime)) throw new HeroImageError(`That file type is not accepted. ${ACCEPTED_TYPES_SENTENCE}`);
  if (bytes.length === 0) throw new HeroImageError("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HeroImageError("That photo is over 15 MB. Export a smaller copy and try again.");
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: "none" }).metadata();
  } catch {
    throw new HeroImageError(/heic|heif/.test(mime) ? "HEIC photos can't be read on this server yet. Export it as JPEG and try again." : `That file isn't a photo we can read. ${ACCEPTED_TYPES_SENTENCE}`);
  }
  if (!meta.width || !meta.height) throw new HeroImageError(`That file isn't a photo we can read. ${ACCEPTED_TYPES_SENTENCE}`);
  // rotate() applies the camera's orientation tag so phone photos come out upright.
  const base = sharp(bytes, { failOn: "none" }).rotate();
  const image = await base.clone().resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
  // Prisma takes Uint8Array over a plain ArrayBuffer; copy out of the pool.
  return { image: new Uint8Array(image.data), thumb: new Uint8Array(thumb), width: image.info.width, height: image.info.height, mimeType: "image/webp" };
}

// The public URL of a slide's image. Absolute when the API knows its own
// address, so the storefront (another origin) can use it as it is.
export function heroImageUrl(id: string): string {
  const base = process.env.PUBLIC_API_URL?.replace(/\/$/, "") ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return `${base}/api/media/hero/${id}`;
}

// A name for a new slide's alt text, from the file name: "adult-party.jpg"
// reads "adult party". The admin edits it afterwards.
export function altFromFileName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ALT_LENGTH);
}
