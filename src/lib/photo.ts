const MAX_EDGE = 1000;
const JPEG_QUALITY = 0.78;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

// Downscales to at most 1000px on the long edge and re-encodes as JPEG,
// returned as a data URL that goes straight into Item.photoUrl. A phone
// photo comes out around 100-200KB instead of several MB. Transparent
// PNGs get a white background, since JPEG has no alpha.
export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is over 20MB");

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't process the image in this browser");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

export function isUploadedPhoto(url: string | null): boolean {
  return url !== null && url.startsWith("data:");
}
