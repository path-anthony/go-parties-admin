import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AdminUser } from "../src/generated/prisma/client.js";
import { getDefaultAccount } from "./account.js";
import { runAsActor, type Actor } from "./actor.js";
import { prisma } from "./db.js";
import { createSession, findSession, revokeSession, signedCookie } from "./sessions.js";
import type { Role } from "./users.js";

export const SESSION_COOKIE = "admin_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// A password that checked out but still needs the authenticator code: a
// short session of its own kind, which no gated route accepts.
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

// The cookie is signed with COOKIE_SECRET (see cookieParser(...) in
// index.ts). Its content is a session id from the sessions table, so a
// session is valid only while its row exists: logout deletes the row, and
// a copied cookie is dead the moment that happens. Since Block U the row
// also names the user, so removing a person deletes their rows.
export function cookieOptions(maxAge = SESSION_MAX_AGE_MS) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge,
  };
}

export async function startAdminSession(res: Response, userId: string): Promise<void> {
  const id = await createSession("admin", SESSION_MAX_AGE_MS, null, userId);
  res.cookie(SESSION_COOKIE, id, cookieOptions());
}

export async function startPendingSession(res: Response, userId: string): Promise<void> {
  const id = await createSession("admin_pending", PENDING_MAX_AGE_MS, null, userId);
  res.cookie(SESSION_COOKIE, id, cookieOptions(PENDING_MAX_AGE_MS));
}

// The person behind a pending (password ok, code due) cookie, or null.
export async function pendingUser(req: Request): Promise<AdminUser | null> {
  const session = await findSession(signedCookie(req, SESSION_COOKIE), "admin_pending");
  return session?.user && session.user.active ? session.user : null;
}

// Upgrades the pending row to a full session in place, so the cookie that
// is already set keeps working.
export async function completePendingSession(req: Request, res: Response): Promise<void> {
  const id = signedCookie(req, SESSION_COOKIE);
  if (typeof id !== "string") return;
  await prisma.session.update({ where: { id }, data: { kind: "admin", expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS) } });
  res.cookie(SESSION_COOKIE, id, cookieOptions());
}

// Revokes the row behind this browser's cookie, then clears the cookie.
// The order matters: the row is what carries the access.
export async function endAdminSession(req: Request, res: Response): Promise<void> {
  await revokeSession(signedCookie(req, SESSION_COOKIE));
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), signed: false, maxAge: undefined });
}

// The signed-in user, or null. A session row from before Block U has no
// user; it stands for the shared login and is treated as the first Owner
// until it expires (seven days at most), so a deploy locks nobody out.
export async function currentUser(req: Request): Promise<AdminUser | null> {
  const session = await findSession(signedCookie(req, SESSION_COOKIE), "admin");
  if (!session) return null;
  if (session.userId) return session.user && session.user.active ? session.user : null;
  const account = await getDefaultAccount();
  return prisma.adminUser.findFirst({ where: { accountId: account.id, active: true, role: "Owner" }, orderBy: { createdAt: "asc" } });
}

export async function isAuthenticated(req: Request): Promise<boolean> {
  return (await currentUser(req)) !== null;
}

export const toActor = (u: AdminUser): Actor => ({ id: u.id, name: u.name, role: u.role as Role });

export const requireAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.locals.user = user;
  // Everything downstream can name who is acting (server/actor.ts).
  runAsActor(toActor(user), () => next());
};

export const OWNER_ONLY_MESSAGE = "Only owners can change this.";

// Behind requireAuth. Staff get a 403 with the same sentence the UI shows.
export const requireOwner: RequestHandler = (_req, res, next) => {
  const user = res.locals.user as AdminUser | undefined;
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.role !== "Owner") return res.status(403).json({ error: OWNER_ONLY_MESSAGE });
  next();
};
