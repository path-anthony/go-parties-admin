import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { availabilityLimiter } from "../rateLimit.js";
import { MAX_NOTICE_HOURS, MAX_PHONE_LENGTH, getSettings } from "../settings.js";
import { normalizeText } from "../validate.js";

// Public, no session: the storefront reads the rush rule from here.
// Mounted on /api/settings ahead of the gated router and defining only
// /public, so everything else stays behind the admin session. The
// response is built field by field.
export const publicSettingsRouter = Router();

publicSettingsRouter.get("/public", availabilityLimiter, async (_req, res) => {
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  res.json({
    minBookingNoticeHours: settings.minBookingNoticeHours,
    rushContactPhone: settings.rushContactPhone,
  });
});

const router = Router();

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json(await getSettings(account.id));
});

router.patch("/", async (req, res) => {
  const body = req.body ?? {};
  const data: { minBookingNoticeHours?: number; rushContactPhone?: string | null } = {};

  if ("minBookingNoticeHours" in body) {
    const hours = body.minBookingNoticeHours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0 || hours > MAX_NOTICE_HOURS) {
      return res.status(400).json({ error: `minBookingNoticeHours must be a whole number of hours from 0 to ${MAX_NOTICE_HOURS} (0 turns rush flagging off)` });
    }
    data.minBookingNoticeHours = hours;
  }
  if ("rushContactPhone" in body) {
    const phone = body.rushContactPhone === null ? null : typeof body.rushContactPhone === "string" ? normalizeText(body.rushContactPhone) : undefined;
    if (phone === undefined || (phone !== null && phone.length > MAX_PHONE_LENGTH)) {
      return res.status(400).json({ error: `rushContactPhone must be text up to ${MAX_PHONE_LENGTH} characters, or blank` });
    }
    data.rushContactPhone = phone;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const account = await getDefaultAccount();
  await prisma.account.update({ where: { id: account.id }, data });
  res.json(await getSettings(account.id));
});

export default router;
