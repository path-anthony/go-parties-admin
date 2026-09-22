import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createSession, findSession, revokeSession, signedCookie } from "./sessions.js";

export const SESSION_COOKIE = "admin_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The cookie is signed with COOKIE_SECRET (see cookieParser(...) in
// index.ts), which is its own value, not the admin password. Its content
// is a session id from the sessions table, so a session is valid only
// while its row exists: logout deletes the row, and a copied cookie is
// dead the moment that happens, however long it had left.
export function cookieOptions() {
  return {
    signed: true,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

export function isValidPassword(password: unknown): boolean {
  return (
    typeof password === "string" && process.env.ADMIN_PASSWORD !== undefined && password === process.env.ADMIN_PASSWORD
  );
}

// Called only after the password checked out: opens a session row and
// hands its id to the browser.
export async function startAdminSession(res: Response): Promise<void> {
  const id = await createSession("admin", SESSION_MAX_AGE_MS);
  res.cookie(SESSION_COOKIE, id, cookieOptions());
}

// Revokes the row behind this browser's cookie, then clears the cookie.
// The order matters: the row is what carries the access.
export async function endAdminSession(req: Request, res: Response): Promise<void> {
  await revokeSession(signedCookie(req, SESSION_COOKIE));
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), signed: false, maxAge: undefined });
}

export async function isAuthenticated(req: Request): Promise<boolean> {
  return (await findSession(signedCookie(req, SESSION_COOKIE), "admin")) !== null;
}

export const requireAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  if (await isAuthenticated(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
};
