import type { NextFunction, Request, RequestHandler, Response } from "express";

export const SESSION_COOKIE = "admin_session";
const SESSION_VALUE = "authenticated";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Signed with ADMIN_PASSWORD itself (see cookieParser(...) in index.ts), so
// rotating the password also invalidates every existing session — no
// separate signing secret to manage.
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

export function setSessionCookie(res: Response) {
  res.cookie(SESSION_COOKIE, SESSION_VALUE, cookieOptions());
}

export function isAuthenticated(req: Request): boolean {
  return req.signedCookies?.[SESSION_COOKIE] === SESSION_VALUE;
}

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
};
