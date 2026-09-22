import { Router } from "express";
import { isAuthenticated, isValidPassword, setSessionCookie } from "../auth.js";
import { adminLoginLimiter } from "../rateLimit.js";

const router = Router();

router.get("/me", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// The limiter only counts failures (see rateLimit.ts), so five wrong
// passwords from one IP in 15 minutes lock that IP out with a clear 429;
// a right password never adds to the count.
router.post("/login", adminLoginLimiter, (req, res) => {
  const { password } = req.body ?? {};
  if (!isValidPassword(password)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

export default router;
