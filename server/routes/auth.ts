import { Router } from "express";
import { endAdminSession, isAuthenticated, isValidPassword, startAdminSession } from "../auth.js";
import { attemptLogin } from "../loginLimit.js";
import { adminLoginBurstLimiter } from "../rateLimit.js";

const router = Router();

router.get("/me", async (req, res) => {
  res.json({ authenticated: await isAuthenticated(req) });
});

// Five wrong passwords from one address in 15 minutes lock that address out
// with a clear 429. The count lives in the database, so a deploy does not
// reset it, and each attempt is recorded before the count is read, so a burst
// of guesses cannot slip past it. A right password never adds to it. The burst limiter in front is a cheap in-memory cap on how often one
// address can make the database do that work at all.
router.post("/login", adminLoginBurstLimiter, async (req, res) => {
  const { password } = req.body ?? {};
  const result = await attemptLogin("admin", req.ip, () => isValidPassword(password));
  if (result === "locked") {
    return res.status(429).json({ error: "Too many failed login attempts from this connection. Try again in 15 minutes." });
  }
  if (result === "failed") {
    return res.status(401).json({ error: "Incorrect password" });
  }
  await startAdminSession(res);
  res.json({ ok: true });
});

// Ends this browser's session on the server, not just in the browser: the
// session row is deleted, so the cookie is dead wherever it was copied.
router.post("/logout", async (req, res) => {
  await endAdminSession(req, res);
  res.json({ ok: true });
});

export default router;
