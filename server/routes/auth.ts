import { Router } from "express";
import { endAdminSession, isAuthenticated, isValidPassword, startAdminSession } from "../auth.js";
import { adminLoginLimiter } from "../rateLimit.js";

const router = Router();

router.get("/me", async (req, res) => {
  res.json({ authenticated: await isAuthenticated(req) });
});

// The limiter only counts failures (see rateLimit.ts), so five wrong
// passwords from one IP in 15 minutes lock that IP out with a clear 429;
// a right password never adds to the count.
router.post("/login", adminLoginLimiter, async (req, res) => {
  const { password } = req.body ?? {};
  if (!isValidPassword(password)) {
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
