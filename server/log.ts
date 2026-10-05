import { createHmac } from "node:crypto";

// Nothing sensitive goes into the server log: no link tokens, no message
// bodies, no phone numbers or emails, no customer text. The hosting platform
// keeps these logs, so treat them as readable by people who should not see a
// customer's phone number or a signing link.

// Long random-looking strings (signing, bid and download tokens are 20 to 64
// URL-safe characters) and the paths that carry them.
const TOKEN_PATH = /\/(sign|bid|pdf|contracts|bids)\/[A-Za-z0-9_-]{8,}/g;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;
const EMAIL = /[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

export function redact(text: string): string {
  return text
    .replace(TOKEN_PATH, "/$1/[token]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, (m) => `[phone ...${m.replace(/\D/g, "").slice(-2)}]`)
    .replace(LONG_TOKEN, "[token]");
}

// "+18605550101" -> "***0101"
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "(none)";
}

export function maskEmail(email: string | null | undefined): string {
  const at = (email ?? "").indexOf("@");
  return at > 0 ? `${email!.slice(0, 1)}***${email!.slice(at)}` : "(none)";
}

// What to print for a caught error: its kind and a short redacted message,
// never the whole object (database errors can carry the query and values).
export function safeErr(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const code = (err as { code?: unknown }).code;
  const firstLine = err.message.split("\n").find((l) => l.trim() !== "" && !l.includes("invocation")) ?? err.message;
  return `${err.name}${typeof code === "string" ? ` ${code}` : ""}: ${redact(firstLine).slice(0, 240)}`;
}

// A keyed hash of an IP address, so it can be counted without being kept.
export function ipHash(ip: string | null | undefined): string {
  return createHmac("sha256", process.env.COOKIE_SECRET ?? "dev").update(ip ?? "unknown").digest("hex").slice(0, 32);
}
