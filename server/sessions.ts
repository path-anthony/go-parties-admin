import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";

// One store for both kinds of session. A session is a row; the cookie
// carries the row's id, signed. Validity is decided here, on every gated
// request, by the row: present, not expired, right kind. A correctly
// signed cookie whose row is gone is worth nothing, which is what makes
// logout real and lets a session be ended from the server side.
export type SessionKind = "admin" | "customer";

// 256 bits from the OS. The signature on the cookie stops tampering in
// transit; the randomness here is what stops guessing an id outright.
function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(kind: SessionKind, maxAgeMs: number, customerId: string | null = null): Promise<string> {
  const account = await getDefaultAccount();
  const now = Date.now();
  // Housekeeping that costs nothing at login time: rows past their expiry
  // are already invalid, so drop them rather than let the table grow.
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  const session = await prisma.session.create({
    data: { id: newSessionId(), accountId: account.id, kind, customerId, expiresAt: new Date(now + maxAgeMs) },
  });
  return session.id;
}

// The row behind a cookie value, or null when the value is missing, was
// never a session, has been revoked, has expired, or is the other kind.
export async function findSession(id: unknown, kind: SessionKind) {
  if (typeof id !== "string" || id === "") return null;
  const session = await prisma.session.findUnique({ where: { id }, include: { customer: true } });
  if (!session || session.kind !== kind) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  return session;
}

// Revoking is deleting. Idempotent: a second logout with the same cookie
// finds nothing and that is fine.
export async function revokeSession(id: unknown): Promise<void> {
  if (typeof id !== "string" || id === "") return;
  await prisma.session.deleteMany({ where: { id } });
}

export function signedCookie(req: Request, name: string): unknown {
  return req.signedCookies?.[name];
}
