import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import type { AdminUser } from "../src/generated/prisma/client.js";
import { getDefaultAccount } from "./account.js";
import { actorFields, currentActor } from "./actor.js";
import { apiBase } from "./contract/links.js";
import { normalizeEmail } from "./customerAuth.js";
import { prisma } from "./db.js";
import { maskEmail, safeErr } from "./log.js";
import { sendEmail } from "./messaging.js";
import { safeInline } from "./sanitize.js";
import { openSecret, sealSecret } from "./secrets.js";
import { newBackupCodes, newSecret, normalizeBackupCode, otpauthUrl, verifyTotp } from "./totp.js";

// Staff accounts for the admin. One row per person, a role, a bcrypt hash,
// and optional two-step sign-in. The shared login from before Block U
// becomes the first Owner (ensureFirstOwner), so a deploy locks nobody out.

export const ROLES = ["Owner", "Staff"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => v === "Owner" || v === "Staff";

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so the time taken is the same.
const DUMMY_HASH = "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
export const TOKEN_TTL_MS = 72 * 3_600_000;
export const BOOTSTRAP_EMAIL = "info@thegoeventgroup.com";
const TOTP_PURPOSE = "totp";
const ISSUER = "GO Event Group";
const MAX_NAME = 80;

export class UserError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---- the first Owner --------------------------------------------------------------
// The shared password (ADMIN_PASSWORD) carries over as the Owner user for
// info@thegoeventgroup.com the first time anyone signs in after the deploy.
// Once a user exists, the env password is never looked at again.
export async function ensureFirstOwner(accountId: string): Promise<void> {
  const count = await prisma.adminUser.count({ where: { accountId } });
  if (count > 0) return;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn("[users] no admin users and ADMIN_PASSWORD is not set: nobody can sign in until one is created.");
    return;
  }
  const email = normalizeEmail(process.env.ADMIN_EMAIL) ?? BOOTSTRAP_EMAIL;
  await prisma.adminUser.create({ data: { accountId, name: "GO Event Group", email, role: "Owner", passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) } });
  console.log(`[users] first Owner created for ${maskEmail(email)} from the shared login.`);
}

// ---- lookups ------------------------------------------------------------------
export async function findUserByEmail(accountId: string, email: string): Promise<AdminUser | null> {
  return prisma.adminUser.findUnique({ where: { accountId_email: { accountId, email } } });
}

export async function checkPassword(user: AdminUser | null, password: string): Promise<boolean> {
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user !== null && user.active && user.passwordHash !== null;
}

export const hasTwoStep = (u: Pick<AdminUser, "totpEnabledAt">): boolean => u.totpEnabledAt !== null;

// What the admin UI sees. Never the hash, never the secret, never the codes.
export function publicUser(u: AdminUser, invitePending = false) {
  return { id: u.id, name: u.name, email: u.email, role: u.role as Role, active: u.active, twoStep: hasTwoStep(u), lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString(), invitePending };
}

export async function listUsers(accountId: string) {
  const users = await prisma.adminUser.findMany({ where: { accountId, active: true }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] });
  const pending = await prisma.adminToken.findMany({ where: { kind: "invite", usedAt: null, expiresAt: { gt: new Date() }, userId: { in: users.map((u) => u.id) } }, select: { userId: true, expiresAt: true } });
  const pendingBy = new Map(pending.map((p) => [p.userId, p.expiresAt]));
  return users.map((u) => ({ ...publicUser(u, u.passwordHash === null), inviteExpiresAt: pendingBy.get(u.id)?.toISOString() ?? null }));
}

// ---- audit --------------------------------------------------------------------
export async function audit(action: string, detail: string | null = null): Promise<void> {
  const account = await getDefaultAccount();
  const a = currentActor();
  await prisma.adminAudit.create({ data: { accountId: account.id, userId: a?.id ?? null, userName: a?.name ?? "system", action, detail } }).catch((err) => console.warn("[audit] not written:", safeErr(err)));
}

// ---- single-use links -----------------------------------------------------------
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

async function issueToken(userId: string, kind: "invite" | "reset", now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  // One live link per person and kind: a resend replaces the earlier one.
  await prisma.adminToken.deleteMany({ where: { userId, kind } });
  await prisma.adminToken.create({ data: { userId, kind, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

// Which person a link belongs to, without spending it (the set-password
// page asks this to show the name). Null when unknown, used or expired.
export async function peekToken(token: string, now = new Date()) {
  if (typeof token !== "string" || token.length < 20) return null;
  const row = await prisma.adminToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime() || !row.user.active) return null;
  return { kind: row.kind as "invite" | "reset", user: row.user };
}

// Spends a link: exactly one caller wins, by an atomic update of the unused row.
export async function consumeToken(token: string, now = new Date()) {
  if (typeof token !== "string" || token.length < 20) return null;
  const hash = hashToken(token);
  const spent = await prisma.adminToken.updateMany({ where: { tokenHash: hash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (spent.count !== 1) return null;
  const row = await prisma.adminToken.findUniqueOrThrow({ where: { tokenHash: hash }, include: { user: true } });
  return row.user.active ? { kind: row.kind as "invite" | "reset", user: row.user } : null;
}

const setPasswordLink = (token: string) => `${apiBase()}/set-password?token=${token}`;

async function mailLink(user: AdminUser, kind: "invite" | "reset", token: string, expiresAt: Date): Promise<void> {
  const link = setPasswordLink(token);
  const until = expiresAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const subject = kind === "invite" ? "You're invited to the GO Event Group admin" : "Reset your GO Event Group admin password";
  const body =
    kind === "invite"
      ? `Hi ${user.name},\n\nYou've been given access to the GO Event Group admin as ${user.role}. Set your password here:\n${link}\n\nThe link works once and expires ${until} ET. If you weren't expecting this, ignore it.`
      : `Hi ${user.name},\n\nSomeone asked to reset the password for this admin account. Set a new one here:\n${link}\n\nThe link works once and expires ${until} ET. If that wasn't you, ignore this and your password stays as it is.`;
  const result = await sendEmail({ to: user.email, subject, body, purpose: kind === "invite" ? "admin-invite" : "admin-password-reset" });
  if (result.status !== "queued" && result.status !== "sent") console.warn(`[users] ${kind} email to ${maskEmail(user.email)} not sent: ${result.status}`);
}

// ---- invites ------------------------------------------------------------------
export async function inviteUser(accountId: string, input: { name: unknown; email: unknown; role: unknown }) {
  const name = safeInline(typeof input.name === "string" ? input.name : "", MAX_NAME);
  const email = normalizeEmail(input.email);
  if (!name) throw new UserError(400, "name is required");
  if (!email) throw new UserError(400, "email must look like an email address");
  if (!isRole(input.role)) throw new UserError(400, "role must be Owner or Staff");
  const existing = await findUserByEmail(accountId, email);
  if (existing?.active) throw new UserError(409, `${email} already has access.`);
  const user = existing
    ? await prisma.adminUser.update({ where: { id: existing.id }, data: { name, role: input.role, active: true, passwordHash: null, totpSecretEnc: null, totpEnabledAt: null, backupCodeHashes: [] } })
    : await prisma.adminUser.create({ data: { accountId, name, email, role: input.role } });
  const { token, expiresAt } = await issueToken(user.id, "invite");
  await mailLink(user, "invite", token, expiresAt);
  await audit("invited", `${name} (${email}) as ${input.role}`);
  return publicUser(user, true);
}

export async function resendInvite(accountId: string, userId: string) {
  const user = await prisma.adminUser.findFirst({ where: { id: userId, accountId, active: true } });
  if (!user) throw new UserError(404, "user not found");
  if (user.passwordHash) throw new UserError(400, `${user.name} has already set a password. Use a password reset instead.`);
  const { token, expiresAt } = await issueToken(user.id, "invite");
  await mailLink(user, "invite", token, expiresAt);
  await audit("invite resent", `${user.name} (${user.email})`);
  return expiresAt;
}

export async function revokeInvite(accountId: string, userId: string) {
  const user = await prisma.adminUser.findFirst({ where: { id: userId, accountId } });
  if (!user) throw new UserError(404, "user not found");
  await prisma.adminToken.deleteMany({ where: { userId, kind: "invite" } });
  // Never signed in: the row has nothing to keep.
  if (user.passwordHash === null) await prisma.adminUser.delete({ where: { id: userId } });
  await audit("invite revoked", `${user.name} (${user.email})`);
}

// ---- passwords ------------------------------------------------------------------
export function passwordProblem(value: unknown): string | null {
  if (typeof value !== "string") return "password is required";
  if (value.length < 10) return "password must be at least 10 characters";
  if (value.length > 128) return "password must be at most 128 characters";
  return null;
}

// A new password signs the person out everywhere else: a reset is usually
// because the old one may be known.
export async function setPassword(userId: string, password: string): Promise<void> {
  await prisma.adminUser.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) } });
  await prisma.adminToken.deleteMany({ where: { userId } });
  await revokeUserSessions(userId);
}

// Always quiet about whether the email exists: the caller answers the same
// way either way, and the email (if any) goes out after the answer.
export async function requestReset(accountId: string, email: string): Promise<void> {
  const user = await findUserByEmail(accountId, email);
  if (!user || !user.active || !user.passwordHash) return;
  const { token, expiresAt } = await issueToken(user.id, "reset");
  await mailLink(user, "reset", token, expiresAt);
}

// ---- roles and removal ------------------------------------------------------------
async function activeOwners(accountId: string, excludingId: string): Promise<number> {
  return prisma.adminUser.count({ where: { accountId, active: true, role: "Owner", passwordHash: { not: null }, id: { not: excludingId } } });
}

export async function changeRole(accountId: string, userId: string, role: unknown) {
  if (!isRole(role)) throw new UserError(400, "role must be Owner or Staff");
  const user = await prisma.adminUser.findFirst({ where: { id: userId, accountId, active: true } });
  if (!user) throw new UserError(404, "user not found");
  if (user.role === role) return publicUser(user, user.passwordHash === null);
  if (user.role === "Owner" && (await activeOwners(accountId, userId)) === 0) throw new UserError(409, "There must always be at least one Owner. Make someone else an Owner first.");
  const updated = await prisma.adminUser.update({ where: { id: userId }, data: { role } });
  await revokeUserSessions(userId);
  await audit("role changed", `${user.name}: ${user.role} to ${role}`);
  return publicUser(updated, updated.passwordHash === null);
}

export async function removeUser(accountId: string, userId: string): Promise<void> {
  const user = await prisma.adminUser.findFirst({ where: { id: userId, accountId, active: true } });
  if (!user) throw new UserError(404, "user not found");
  if (user.role === "Owner" && (await activeOwners(accountId, userId)) === 0) throw new UserError(409, "There must always be at least one Owner. Make someone else an Owner first.");
  await prisma.adminUser.update({ where: { id: userId }, data: { active: false, passwordHash: null, totpSecretEnc: null, totpEnabledAt: null, backupCodeHashes: [] } });
  await prisma.adminToken.deleteMany({ where: { userId } });
  await revokeUserSessions(userId);
  await audit("removed", `${user.name} (${user.email})`);
}

// Every session of this person is deleted, so their next request is a 401
// wherever they are signed in.
export async function revokeUserSessions(userId: string): Promise<number> {
  return (await prisma.session.deleteMany({ where: { userId } })).count;
}

export async function recordLogin(userId: string, at = new Date()): Promise<void> {
  await prisma.adminUser.update({ where: { id: userId }, data: { lastLoginAt: at } });
}

// ---- two-step sign-in -----------------------------------------------------------------
// Setup is two calls: begin makes a secret and shows the QR; confirm proves
// the app has it (one valid code) and only then turns it on, handing out
// the backup codes once.
export async function beginTotpSetup(userId: string): Promise<{ secret: string; otpauth: string; qrSvg: string }> {
  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  if (hasTwoStep(user)) throw new UserError(409, "Two-step sign-in is already on. Turn it off first to set it up again.");
  const secret = newSecret();
  await prisma.adminUser.update({ where: { id: userId }, data: { totpSecretEnc: sealSecret(TOTP_PURPOSE, secret), totpEnabledAt: null } });
  const otpauth = otpauthUrl(secret, user.email, ISSUER);
  const qrSvg = await QRCode.toString(otpauth, { type: "svg", margin: 1, width: 180 });
  return { secret, otpauth, qrSvg };
}

export async function confirmTotpSetup(userId: string, code: string): Promise<string[]> {
  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  if (hasTwoStep(user)) throw new UserError(409, "Two-step sign-in is already on.");
  if (!user.totpSecretEnc) throw new UserError(400, "Start the setup first.");
  if (!verifyTotp(openSecret(TOTP_PURPOSE, user.totpSecretEnc), code)) throw new UserError(400, "That code didn't match. Check the app and try again.");
  const codes = newBackupCodes();
  await prisma.adminUser.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), backupCodeHashes: codes.map((c) => hashToken(normalizeBackupCode(c))) } });
  await audit("two-step turned on");
  return codes;
}

export async function disableTotp(userId: string, password: string): Promise<void> {
  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  if (!(await checkPassword(user, password))) throw new UserError(400, "That password didn't match.");
  await prisma.adminUser.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, backupCodeHashes: [] } });
  await audit("two-step turned off");
}

// The second step at sign-in: an app code, or one backup code (spent on use).
export async function verifySecondStep(userId: string, code: string): Promise<boolean> {
  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpSecretEnc || !hasTwoStep(user)) return false;
  if (verifyTotp(openSecret(TOTP_PURPOSE, user.totpSecretEnc), code)) return true;
  const hash = hashToken(normalizeBackupCode(code));
  if (!user.backupCodeHashes.includes(hash)) return false;
  // Atomic: the array is replaced only if it still holds this code.
  const spent = await prisma.adminUser.updateMany({ where: { id: userId, backupCodeHashes: { has: hash } }, data: { backupCodeHashes: user.backupCodeHashes.filter((h) => h !== hash) } });
  return spent.count === 1;
}

export async function changeOwnPassword(userId: string, current: string, next: string): Promise<void> {
  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  if (!(await checkPassword(user, current))) throw new UserError(400, "Your current password didn't match.");
  const problem = passwordProblem(next);
  if (problem) throw new UserError(400, problem);
  await prisma.adminUser.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS) } });
  await audit("password changed");
}

export { actorFields };
