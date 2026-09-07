import { Router } from "express";
import { isAuthenticated, isValidPassword, setSessionCookie } from "../auth.js";

const router = Router();

router.get("/me", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

router.post("/login", (req, res) => {
  const { password } = req.body ?? {};
  if (!isValidPassword(password)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

export default router;
