import { Router } from "express";
import { MAX_PAGE_SIZE, isNotificationType, listNotifications, markAllRead, markRead } from "../notifications.js";

// The bell and the Notifications page. Mounted behind the admin session and
// not in PUBLIC_ROUTES, so no other origin can call it.
const router = Router();

function wholeNumber(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

router.get("/", async (req, res) => {
  const page = wholeNumber(req.query.page, 1, 100_000);
  const limit = wholeNumber(req.query.limit, 25, MAX_PAGE_SIZE);
  if (page === null) return res.status(400).json({ error: "page must be a whole number from 1" });
  if (limit === null) return res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}` });
  const type = req.query.type;
  if (type !== undefined && !isNotificationType(type)) return res.status(400).json({ error: "type is not a known notification type" });
  res.json(await listNotifications({ page, limit, type: type ?? null }));
});

router.post("/read-all", async (_req, res) => {
  res.json({ marked: await markAllRead() });
});

router.post("/:id/read", async (req, res) => {
  if (!(await markRead(String(req.params.id)))) return res.status(404).json({ error: "notification not found" });
  res.json({ ok: true });
});

export default router;
