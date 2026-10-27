import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238 over RFC 4226), the kind every
// authenticator app makes: HMAC-SHA1, 30-second steps, six digits. Pure
// and small enough that no dependency is needed; the whole thing is
// checked in server/tests/totp.test.ts against the RFC's own vectors.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 20 random bytes, as the base32 text the app is given.
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totp(secret: string, atMs = Date.now()): string {
  return hotp(secret, Math.floor(atMs / 1000 / STEP_SECONDS));
}

// Accepts the current step and one either side, which covers a phone clock
// a little off and a code typed just as it rolled over.
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  const typed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(typed)) return false;
  const step = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (const delta of [0, -1, 1]) {
    const expected = hotp(secret, step + delta);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return true;
  }
  return false;
}

// What the authenticator app scans.
export function otpauthUrl(secret: string, label: string, issuer: string): string {
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${q.toString()}`;
}

// Backup codes: eight of "xxxx-xxxx" from an alphabet with no look-alikes.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const b = randomBytes(8);
    const chars = Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}

export const normalizeBackupCode = (code: string): string => code.toLowerCase().replace(/[^a-z0-9]/g, "");
