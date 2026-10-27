import { Router } from "express";
import type { AdminUser } from "../../src/generated/prisma/client.js";
import { getDefaultAccount } from "../account.js";
import { completePendingSession, currentUser, endAdminSession, pendingUser, requireAuth, startAdminSession, startPendingSession } from "../auth.js";
import { normalizeEmail } from "../customerAuth.js";
import { attemptLogin } from "../loginLimit.js";
import { adminLoginBurstLimiter } from "../rateLimit.js";
import { BOOTSTRAP_EMAIL, UserError, beginTotpSetup, changeOwnPassword, checkPassword, confirmTotpSetup, consumeToken, disableTotp, ensureFirstOwner, findUserByEmail, hasTwoStep, passwordProblem, peekToken, publicUser, recordLogin, requestReset, setPassword, verifySecondStep } from "../users.js";

const router = Router();

// One sentence for a wrong email, a wrong password, a removed person and an
// invite not yet accepted: a login attempt never says whether an email exists.
const BAD_LOGIN = "That email and password don't match.";

const fail = (res: import("express").Response, err: unknown) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  throw err;
};

router.get("/me", async (req, res) => {
  const user = await currentUser(req);
  res.json({ authenticated: user !== null, user: user ? publicUser(user) : null });
});

// Five wrong passwords from one address in 15 minutes lock that address out
// with a clear 429. The count lives in the database, so a deploy does not
// reset it, and each attempt is recorded before the count is read, so a burst
// of guesses cannot slip past it. The burst limiter in front is a cheap
// in-memory cap on how often one address can make the database do that work.
router.post("/login", adminLoginBurstLimiter, async (req, res) => {
  const body = req.body ?? {};
  const account = await getDefaultAccount();
  await ensureFirstOwner(account.id);
  // An older admin bundle sends only the password; that is the shared login,
  // which is now the first Owner's.
  const email = normalizeEmail(body.email) ?? (body.email === undefined ? (normalizeEmail(process.env.ADMIN_EMAIL) ?? BOOTSTRAP_EMAIL) : null);
  const password = typeof body.password === "string" ? body.password : "";
  let user: AdminUser | null = null;
  const result = await attemptLogin("admin", req.ip, async () => {
    user = email ? await findUserByEmail(account.id, email) : null;
    return checkPassword(user, password);
  });
  if (result === "locked") {
    return res.status(429).json({ error: "Too many failed login attempts from this connection. Try again in 15 minutes." });
  }
  if (result === "failed" || !user) {
    return res.status(401).json({ error: BAD_LOGIN });
  }
  const u = user as AdminUser;
  if (hasTwoStep(u)) {
    await startPendingSession(res, u.id);
    return res.json({ ok: true, twoStep: true });
  }
  await startAdminSession(res, u.id);
  await recordLogin(u.id);
  res.json({ ok: true, twoStep: false, user: publicUser(u) });
});

// The authenticator code (or a backup code) after the password.
router.post("/two-step", adminLoginBurstLimiter, async (req, res) => {
  const user = await pendingUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with your password first." });
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const result = await attemptLogin("admin-2fa", req.ip, () => verifySecondStep(user.id, code));
  if (result === "locked") return res.status(429).json({ error: "Too many wrong codes from this connection. Try again in 15 minutes." });
  if (result === "failed") return res.status(401).json({ error: "That code didn't match." });
  await completePendingSession(req, res);
  await recordLogin(user.id);
  res.json({ ok: true, user: publicUser(user) });
});

// Ends this browser's session on the server, not just in the browser: the
// session row is deleted, so the cookie is dead wherever it was copied.
router.post("/logout", async (req, res) => {
  await endAdminSession(req, res);
  res.json({ ok: true });
});

// Password reset by email. The answer is the same whether or not the
// address belongs to anyone.
router.post("/forgot", adminLoginBurstLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (email) {
    const account = await getDefaultAccount();
    await requestReset(account.id, email);
  }
  res.json({ ok: true, message: "If that email has access, a reset link is on its way." });
});

// The set-password page asks who the link is for before showing the form.
router.get("/token", async (req, res) => {
  const found = await peekToken(typeof req.query.token === "string" ? req.query.token : "");
  if (!found) return res.status(404).json({ error: "That link is not valid, was already used, or has expired." });
  res.json({ kind: found.kind, name: found.user.name, email: found.user.email });
});

// Spends an invite or reset link and sets the password. Signs the person
// in right away for an invite.
router.post("/set-password", adminLoginBurstLimiter, async (req, res) => {
  const problem = passwordProblem(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });
  const found = await consumeToken(typeof req.body?.token === "string" ? req.body.token : "");
  if (!found) return res.status(400).json({ error: "That link is not valid, was already used, or has expired. Ask for a new one." });
  await setPassword(found.user.id, req.body.password);
  if (hasTwoStep(found.user)) {
    await startPendingSession(res, found.user.id);
    return res.json({ ok: true, twoStep: true });
  }
  await startAdminSession(res, found.user.id);
  await recordLogin(found.user.id);
  res.json({ ok: true, twoStep: false, user: publicUser(found.user) });
});

// ---- signed in: own account ------------------------------------------------------
router.post("/password", requireAuth, async (req, res) => {
  const user = res.locals.user as AdminUser;
  try {
    await changeOwnPassword(user.id, typeof req.body?.current === "string" ? req.body.current : "", req.body?.next);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/two-step/setup", requireAuth, async (_req, res) => {
  const user = res.locals.user as AdminUser;
  try {
    res.json(await beginTotpSetup(user.id));
  } catch (err) {
    fail(res, err);
  }
});

router.post("/two-step/confirm", requireAuth, async (req, res) => {
  const user = res.locals.user as AdminUser;
  try {
    const backupCodes = await confirmTotpSetup(user.id, typeof req.body?.code === "string" ? req.body.code : "");
    res.json({ ok: true, backupCodes });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/two-step/disable", requireAuth, async (req, res) => {
  const user = res.locals.user as AdminUser;
  try {
    await disableTotp(user.id, typeof req.body?.password === "string" ? req.body.password : "");
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
