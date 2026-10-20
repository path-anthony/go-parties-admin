import { createHash } from "node:crypto";
import { decryptToken, encryptToken } from "./google/crypto.js";

// A per-purpose key derived from COOKIE_SECRET, for small secrets that must
// be unreadable in a database dump (the TOTP seeds). Rotating COOKIE_SECRET
// invalidates these, which also signs everyone out, so the two go together.
function keyFor(purpose: string): Buffer {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error("COOKIE_SECRET is not set");
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

export const sealSecret = (purpose: string, plain: string): string => encryptToken(plain, keyFor(purpose));
export const openSecret = (purpose: string, stored: string): string => decryptToken(stored, keyFor(purpose));
