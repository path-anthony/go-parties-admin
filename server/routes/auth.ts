import { Router } from "express";
import { endAdminSession, isAuthenticated, isValidPassword, startAdminSession } from "../auth.js";
import { isLockedOut, recordFailure } from "../loginLimit.js";

const router = Router();

router.get("/me", async (req, res) => {
  res.json({ authenticated: await isAuthenticated(req) });
});

// Five wrong passwords from one address in 15 minutes lock that address out
// with a clear 429. The count lives in the database, so a deploy does not
// reset it; a right password never adds to it.
router.post("/login", async (req, res) => {
  if (await isLockedOut("admin", req.ip)) {
    return res.status(429).json({ error: "Too many failed login attempts from this connection. Try again in 15 minutes." });
  }
  const { password } = req.body ?? {};
  if (!isValidPassword(password)) {
    await recordFailure("admin", req.ip);
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
