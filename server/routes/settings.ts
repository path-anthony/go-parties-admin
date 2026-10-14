import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { MAX_POLICY_LENGTH, currentPolicy, listPolicyVersions, publicPolicy, savePolicy } from "../policy.js";
import { availabilityLimiter } from "../rateLimit.js";
import { MAX_NOTICE_HOURS, MAX_PHONE_LENGTH, getSettings } from "../settings.js";
import { canonicalOccasion } from "../../src/lib/occasions.js";
import { listTermsVersions, saveServiceRows, saveTerms, serviceRows, validateServiceRows, validateTerms } from "../contract/goTerms.js";
import { INVALID, normalizePhotoUrl, normalizeText } from "../validate.js";

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
  // Only what the storefront renders: the rush warning, the day-of phone,
  // the policy and the numbers its text may merge. The review threshold and
  // the review occasion list are staff rules enforced on the server; a
  // customer has no use for them and no reason to learn where the line is.
  res.json({
    minBookingNoticeHours: settings.minBookingNoticeHours,
    rushContactPhone: settings.rushContactPhone,
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
    aiDailyCap?: number;
    directBookingDailyCap?: number;
    requireBotCheck?: boolean;
    holdReleaseDays?: number;
    contractCompanyName?: string;
    contractAddressLine?: string;
    contractPhone?: string;
    contractEmail?: string;
    contractWebsite?: string;
    contractFooterLine?: string;
    contractLogo?: string | null;
    balanceDueDays?: number;
    rescheduleFeePercent?: number;
    outsidePlannerChargePercent?: number;
    returnedCheckFee?: number;
    signAndPayWindowDays?: number;
    useGoContract?: boolean;
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
      return res.status(400).json({ error: "The retainer percentage must be a number from 0 to 100" });
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
  for (const [field, max] of [["aiDailyCap", 100000], ["directBookingDailyCap", 10000], ["holdReleaseDays", 365]] as const) {
    if (field in body) {
      const n = body[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) {
        return res.status(400).json({ error: `${field} must be a whole number from 0 to ${max}` });
      }
      data[field] = n;
    }
  }
  // The GO contract's company details: text as it should print. Required,
  // so a blank never reaches a contract.
  for (const [field, max] of [["contractCompanyName", 120], ["contractAddressLine", 200], ["contractPhone", 60], ["contractEmail", 120], ["contractWebsite", 120], ["contractFooterLine", 300]] as const) {
    if (field in body) {
      const v = typeof body[field] === "string" ? normalizeText(body[field]) : null;
      if (!v || v.length > max) return res.status(400).json({ error: `${field} is required, up to ${max} characters` });
      data[field] = v;
    }
  }
  if ("contractLogo" in body) {
    if (body.contractLogo === null) data.contractLogo = null;
    else {
      const logo = normalizePhotoUrl(body.contractLogo);
      if (logo === INVALID || logo === null || !logo.startsWith("data:image/") || logo.length > 2_000_000) {
        return res.status(400).json({ error: "The logo must be an uploaded png, jpeg, gif or webp image" });
      }
      data.contractLogo = logo;
    }
  }
  for (const [field, max] of [["balanceDueDays", 365], ["signAndPayWindowDays", 365]] as const) {
    if (field in body) {
      const n = body[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) return res.status(400).json({ error: `${field} must be a whole number of days from 0 to ${max}` });
      data[field] = n;
    }
  }
  for (const [field, max] of [["rescheduleFeePercent", 100], ["outsidePlannerChargePercent", 100], ["returnedCheckFee", 100000]] as const) {
    if (field in body) {
      const n = body[field];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) return res.status(400).json({ error: `${field} must be a number from 0 to ${max}` });
      data[field] = Math.round(n * 100) / 100;
    }
  }
  if ("useGoContract" in body) {
    if (typeof body.useGoContract !== "boolean") return res.status(400).json({ error: "useGoContract must be true or false" });
    data.useGoContract = body.useGoContract;
  }
  if ("requireBotCheck" in body) {
    if (typeof body.requireBotCheck !== "boolean") return res.status(400).json({ error: "requireBotCheck must be true or false" });
    data.requireBotCheck = body.requireBotCheck;
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

// ---- the GO contract's wording and service rows ----------------------------------

// Every version, newest first, with how many agreements pin each.
router.get("/contract-terms", async (_req, res) => {
  const account = await getDefaultAccount();
  const versions = await listTermsVersions(account.id);
  res.json({ current: versions[0], versions });
});

// Saving adds a version; it never edits or removes an earlier one.
router.post("/contract-terms", async (req, res) => {
  const content = validateTerms((req.body ?? {}).content);
  if (typeof content === "string") return res.status(400).json({ error: content });
  const account = await getDefaultAccount();
  try {
    const { created, version } = await saveTerms(account.id, content);
    res.status(created ? 201 : 200).json({ created, version });
  } catch (err) {
    if ((err as { code?: unknown }).code === "P2002") return res.status(409).json({ error: "The terms were just saved by someone else. Reload and try again." });
    throw err;
  }
});

router.get("/contract-services", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json({ rows: await serviceRows(account.id) });
});

// Replaces the list. Rows keep their ids when sent back, so bookings' per-row
// overrides stay attached.
router.put("/contract-services", async (req, res) => {
  const rows = validateServiceRows((req.body ?? {}).rows);
  if (typeof rows === "string") return res.status(400).json({ error: rows });
  const account = await getDefaultAccount();
  res.json({ rows: await saveServiceRows(account.id, rows) });
});

export default router;
