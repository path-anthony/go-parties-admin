import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The Google refresh token at rest: AES-256-GCM under GOOGLE_TOKEN_ENCRYPTION_KEY
// (32 bytes, given as 64 hex characters or as base64). The stored form is
// base64 of iv (12) + auth tag (16) + ciphertext. Nothing here logs.

export function encryptionKey(): Buffer | null {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptToken(stored: string, key: Buffer): string {
  const buf = Buffer.from(stored, "base64");
  if (buf.length < 29) throw new Error("stored token is too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// The OAuth state parameter: "<nonce>.<hmac>", the hmac over nonce and the
// admin session id under COOKIE_SECRET, so a state can only be spent by the
// session that started it and cannot be forged.
export function signState(nonce: string, sessionId: string): string {
  return `${nonce}.${createHmac("sha256", process.env.COOKIE_SECRET ?? "dev").update(`${nonce}:${sessionId}`).digest("base64url")}`;
}

export function verifyState(state: string, sessionId: string): string | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const nonce = state.slice(0, dot);
  const expected = signState(nonce, sessionId);
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? nonce : null;
}
