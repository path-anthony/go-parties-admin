import { Router } from "express";
import { runAutomation } from "../automation/runner.js";

const router = Router();

const MAX_WINDOW_DAYS = 120;

// The scheduler pass. n8n calls this hourly. It plans all three journeys
// (lead nurture, client, crew) with the same planner the admin screens use
// and sends everything that is due through sendTemplatedMessage. Calling it
// twice in a row, or after a missed hour, is safe: each message has an
// idempotency key, and overdue ones follow the catch-up rules in
// server/automation/planner.ts.
//
//   ?dryRun=true (or dryRun in the body) reports what would go and sends and
//   logs nothing. windowDays overrides how far ahead of the event balance
//   reminders start (default: the account's balanceReminderWindowDays).
//
// Mounted behind the n8n shared secret (x-webhook-secret), checked with a
// timing-safe comparison.
router.post("/check-reminders", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const q = req.query.dryRun;
  const dryRunValue = q !== undefined ? q === "true" || q === "1" : body.dryRun;
  if (dryRunValue !== undefined && typeof dryRunValue !== "boolean") {
    return res.status(400).json({ error: "dryRun must be true or false" });
  }
  const windowDays = body.windowDays;
  if (windowDays !== undefined && (typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 0 || windowDays > MAX_WINDOW_DAYS)) {
    return res.status(400).json({ error: `windowDays must be a whole number from 0 to ${MAX_WINDOW_DAYS}` });
  }
  const result = await runAutomation({ dryRun: dryRunValue === true, source: "n8n", windowDays: windowDays as number | undefined });
  res.json(result);
});

export default router;
