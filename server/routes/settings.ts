import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { MAX_POLICY_LENGTH, currentPolicy, listPolicyVersions, publicPolicy, savePolicy } from "../policy.js";
import { availabilityLimiter } from "../rateLimit.js";
import { MAX_NOTICE_HOURS, MAX_PHONE_LENGTH, getSettings } from "../settings.js";
import { canonicalOccasion } from "../../src/lib/occasions.js";
import { normalizeText } from "../validate.js";

const MAX_THRESHOLD = 10_000_000;
const MAX_CANCELLATION_DAYS = 365;

// Public, no session: the storefront reads the booking rules from here.
// Mounted on /api/settings ahead of the gated router and defining only
// /public, so everything else stays behind the admin session. The
// response is built field by field: internal switches never appear in it.
export const publicSettingsRouter = Router();

publicSettingsRouter.get("/public", availabilityLimiter, async (_req, res) => {
  const account = await getDefaultAccount();
  const [settings, policy] = await Promise.all([getSettings(account.id), currentPolicy(account.id)]);
  res.json({
    minBookingNoticeHours: settings.minBookingNoticeHours,
    rushContactPhone: settings.rushContactPhone,
    fullReviewThreshold: settings.fullReviewThreshold,
    reviewOccasions: settings.reviewOccasions,
    depositPercentage: settings.depositPercentage,
    cancellationWindowDays: settings.cancellationWindowDays,
    policy: publicPolicy(policy),
  });
});

const router = Router();

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json(await getSettings(account.id));
});

router.patch("/", async (req, res) => {
  const body = req.body ?? {};
  const data: {
    minBookingNoticeHours?: number;
    rushContactPhone?: string | null;
    fullReviewThreshold?: number;
    reviewOccasions?: string[];
    depositPercentage?: number;
    cancellationWindowDays?: number;
    requireAgreementCheckbox?: boolean;
    staffNotifyPhone?: string | null;
    staffNotifyEmail?: string | null;
    balanceReminderWindowDays?: number;
    authorizedSignerName?: string | null;
    authorizedSignerTitle?: string | null;
  } = {};

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
  if ("fullReviewThreshold" in body) {
    const amount = body.fullReviewThreshold;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_THRESHOLD) {
      return res.status(400).json({ error: `fullReviewThreshold must be a dollar amount from 0 to ${MAX_THRESHOLD}` });
    }
    data.fullReviewThreshold = Math.round(amount * 100) / 100;
  }
  if ("reviewOccasions" in body) {
    const list = body.reviewOccasions;
    if (!Array.isArray(list) || !list.every((o): o is string => typeof o === "string")) {
      return res.status(400).json({ error: "reviewOccasions must be a list of occasions" });
    }
    const canonical = list.map((o) => canonicalOccasion(o));
    const unknown = list.filter((_, i) => canonical[i] === null);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown occasion${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Pick from the list in Settings.` });
    }
    data.reviewOccasions = [...new Set(canonical as string[])];
  }
  if ("depositPercentage" in body) {
    const pct = body.depositPercentage;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: "depositPercentage must be a number from 0 to 100" });
    }
    data.depositPercentage = Math.round(pct * 100) / 100;
  }
  if ("cancellationWindowDays" in body) {
    const days = body.cancellationWindowDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_CANCELLATION_DAYS) {
      return res.status(400).json({ error: `cancellationWindowDays must be a whole number of days from 0 to ${MAX_CANCELLATION_DAYS}` });
    }
    data.cancellationWindowDays = days;
  }
  for (const field of ["staffNotifyPhone", "staffNotifyEmail"] as const) {
    if (field in body) {
      const v = body[field] === null ? null : typeof body[field] === "string" ? normalizeText(body[field]) : undefined;
      if (v === undefined || (v !== null && v.length > 200)) {
        return res.status(400).json({ error: `${field} must be text up to 200 characters, or blank` });
      }
      if (field === "staffNotifyEmail" && v !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
        return res.status(400).json({ error: "staffNotifyEmail must be an email address" });
      }
      data[field] = v;
    }
  }
  for (const field of ["authorizedSignerName", "authorizedSignerTitle"] as const) {
    if (field in body) {
      const v = body[field] === null ? null : typeof body[field] === "string" ? normalizeText(body[field]) : undefined;
      if (v === undefined || (v !== null && v.length > 120)) {
        return res.status(400).json({ error: `${field} must be text up to 120 characters, or blank` });
      }
      data[field] = v;
    }
  }
  if ("balanceReminderWindowDays" in body) {
    const days = body.balanceReminderWindowDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 120) {
      return res.status(400).json({ error: "balanceReminderWindowDays must be a whole number of days from 0 to 120" });
    }
    data.balanceReminderWindowDays = days;
  }
  if ("requireAgreementCheckbox" in body) {
    if (typeof body.requireAgreementCheckbox !== "boolean") {
      return res.status(400).json({ error: "requireAgreementCheckbox must be true or false" });
    }
    data.requireAgreementCheckbox = body.requireAgreementCheckbox;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const account = await getDefaultAccount();
  await prisma.account.update({ where: { id: account.id }, data });
  res.json(await getSettings(account.id));
});

// The policy text and every version of it, newest first, with how many
// agreements point at each.
router.get("/policy", async (_req, res) => {
  const account = await getDefaultAccount();
  const versions = await listPolicyVersions(account.id);
  res.json({
    current: { id: versions[0].id, version: versions[0].version, text: versions[0].text, createdAt: versions[0].createdAt },
    versions: versions.map((v) => ({ id: v.id, version: v.version, text: v.text, createdAt: v.createdAt, agreements: v._count.agreements })),
  });
});

// Saving adds a version; it never edits or removes an earlier one.
router.post("/policy", async (req, res) => {
  const text = (req.body ?? {}).text;
  if (typeof text !== "string" || text.length > MAX_POLICY_LENGTH) {
    return res.status(400).json({ error: `text is required, up to ${MAX_POLICY_LENGTH} characters` });
  }
  const account = await getDefaultAccount();
  try {
    const { created, policy } = await savePolicy(account.id, text);
    res.status(created ? 201 : 200).json({ created, version: { id: policy.id, version: policy.version, text: policy.text, createdAt: policy.createdAt } });
  } catch (err) {
    if ((err as { code?: unknown }).code === "P2002") {
      return res.status(409).json({ error: "The policy was just saved by someone else. Reload and try again." });
    }
    throw err;
  }
});

export default router;
