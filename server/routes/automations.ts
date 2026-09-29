import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { sendBalanceReminder } from "../notify.js";
import { getSettings } from "../settings.js";
import { todayEastern } from "../validate.js";

const router = Router();

const MAX_WINDOW_DAYS = 120;
const REMIND_EVERY_DAYS = 3;

const addDays = (dateText: string, days: number) => new Date(new Date(`${dateText}T00:00:00Z`).getTime() + days * 86_400_000);

// The balance reminder check. n8n will call this on a schedule later; today
// nothing does. It finds live bookings whose retainer is paid, whose
// balance is not, and whose event starts inside the window (the account's
// balanceReminderWindowDays, or windowDays in the body), and texts each
// customer once per REMIND_EVERY_DAYS. Auto-charge bookings are left
// alone, since the charge itself is a later phase. A reminder that was only
// skipped (no Twilio token yet) does not count as sent, so it is tried
// again on the next run. dryRun: true reports who would be reminded and
// sends nothing.
//
// Mounted behind the n8n shared secret (x-webhook-secret), checked with a
// timing-safe comparison.
router.post("/check-reminders", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  const windowDays = body.windowDays === undefined ? (await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { balanceReminderWindowDays: true } })).balanceReminderWindowDays : body.windowDays;
  if (typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 0 || windowDays > MAX_WINDOW_DAYS) {
    return res.status(400).json({ error: `windowDays must be a whole number from 0 to ${MAX_WINDOW_DAYS}` });
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return res.status(400).json({ error: "dryRun must be true or false" });
  }
  const dryRun = body.dryRun === true;

  const today = todayEastern();
  const remindedBefore = new Date(Date.now() - REMIND_EVERY_DAYS * 86_400_000);
  const candidates = await prisma.booking.findMany({
    where: {
      accountId: account.id,
      status: { notIn: ["Cancelled", "Completed"] },
      retainerPaid: true,
      balancePaid: false,
      total: { not: null },
      balancePaymentPreference: { not: "Auto-charge" },
      eventDate: { gte: addDays(today, 0), lte: addDays(today, windowDays) },
      OR: [{ lastBalanceReminderAt: null }, { lastBalanceReminderAt: { lt: remindedBefore } }],
    },
    orderBy: { eventDate: "asc" },
    select: { id: true, customerName: true, eventDate: true, total: true, balancePaymentPreference: true },
  });

  const results = [];
  for (const b of candidates) {
    const balance = Math.round(Number(b.total) * (100 - settings.depositPercentage)) / 100;
    let result = "dry-run";
    if (!dryRun) {
      const sent = await sendBalanceReminder(b.id);
      result = sent?.status ?? "not-sent";
      if (sent?.status === "sent") await prisma.booking.update({ where: { id: b.id }, data: { lastBalanceReminderAt: new Date() } });
    }
    results.push({ bookingId: b.id, customerName: b.customerName, eventDate: b.eventDate.toISOString().slice(0, 10), balance, balancePaymentPreference: b.balancePaymentPreference, result });
  }
  res.json({ windowDays, dryRun, today, due: results.length, reminders: results });
});

export default router;
