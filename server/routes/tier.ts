import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { parseAddonSelections } from "../addons.js";
import { AddonSelectionError } from "../addons.js";
import { currentPolicy, publicPolicy } from "../policy.js";
import { CartError, issueQuote, normalizeCart, resolveCart, tierFor } from "../quotes.js";
import { getSettings } from "../settings.js";
import { tier1Amount } from "../tiers.js";
import { canonicalOccasion } from "../../src/lib/occasions.js";
import { INVALID, normalizeDate, normalizeText, todayEastern } from "../validate.js";
import { safeInline } from "../sanitize.js";

// Block T1. POST /api/bookings/tier: which agreement a cart needs. Public
// (the storefront asks once the cart and date are fixed, and again right
// before the hold), rate limited where it is mounted. A tier 2 answer
// carries the quote: the GO contract composed from the cart, and the hash
// the signature must match. The thresholds themselves are never sent.

const router = Router();

router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let itemIds: string[];
  if (body.itemIds !== undefined && body.itemId !== undefined) return res.status(400).json({ error: "send itemId or itemIds, not both" });
  if (body.itemIds !== undefined) {
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0 || !body.itemIds.every((id): id is string => typeof id === "string" && id !== "")) return res.status(400).json({ error: "itemIds must be a non-empty array of item ids" });
    itemIds = [...new Set(body.itemIds as string[])];
    if (itemIds.length > 10) return res.status(400).json({ error: "itemIds can hold at most 10 items" });
  } else if (typeof body.itemId === "string" && body.itemId !== "") itemIds = [body.itemId];
  else return res.status(400).json({ error: "itemId or itemIds is required" });
  const date = normalizeDate(body.eventDate);
  if (date === null || date === INVALID) return res.status(400).json({ error: "eventDate is required and must be a valid YYYY-MM-DD date" });
  const dateText = date.toISOString().slice(0, 10);
  if (dateText < todayEastern()) return res.status(400).json({ error: "eventDate can't be in the past" });
  const eventTime = body.eventTime === undefined || body.eventTime === null ? null : typeof body.eventTime === "string" ? safeInline(body.eventTime, 60) || null : INVALID;
  if (eventTime === INVALID) return res.status(400).json({ error: "eventTime must be text" });
  let occasion: string | null = null;
  if (body.occasion !== undefined && body.occasion !== null && body.occasion !== "") {
    occasion = typeof body.occasion === "string" ? canonicalOccasion(body.occasion) : null;
    if (!occasion) return res.status(400).json({ error: "occasion must be a known occasion, like Wedding or Sweet 16" });
  }
  const packageId = body.packageId === undefined || body.packageId === null ? null : typeof body.packageId === "string" && body.packageId !== "" ? body.packageId : INVALID;
  if (packageId === INVALID) return res.status(400).json({ error: "packageId must be a package id" });
  const selections = parseAddonSelections(body.addons, itemIds);
  if (typeof selections === "string") return res.status(400).json({ error: selections, reason: "addon-invalid" });
  const addons = selections.size > 0 ? Object.fromEntries(selections.entries()) : null;
  const cart = normalizeCart({ itemIds, packageId, addons, eventDate: dateText, eventTime, occasion: normalizeText(occasion) });

  const account = await getDefaultAccount();
  let resolved;
  try {
    resolved = await resolveCart(account.id, cart);
  } catch (err) {
    if (err instanceof CartError) return res.status(err.status).json({ error: err.message, reason: err.reason });
    if (err instanceof AddonSelectionError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
  const { tier, reasons } = await tierFor(account.id, resolved);
  const settings = await getSettings(account.id);
  const total = resolved.total;
  if (tier === 3) {
    return res.json({ tier, reasons, total, retainerPercent: settings.depositPercentage, retainerAmount: total === null ? null : Math.round(total * settings.depositPercentage) / 100, policy: null, contract: null, quoteExpiresAt: null });
  }
  if (tier === 2) {
    const q = await issueQuote(account.id, cart, resolved);
    return res.json({
      tier,
      reasons,
      total: q.totalCents / 100,
      retainerPercent: settings.depositPercentage,
      retainerAmount: q.retainerCents / 100,
      policy: null,
      contract: { quoteId: q.quoteId, contentHash: q.contentHash, termsVersion: q.termsVersion, format: "go-v2", document: q.document },
      quoteExpiresAt: q.quoteExpiresAt,
    });
  }
  const policy = publicPolicy(await currentPolicy(account.id));
  const collect = settings.tier1Collect === "full" ? "full" : "retainer";
  res.json({
    tier,
    reasons,
    total,
    retainerPercent: collect === "full" ? 100 : settings.depositPercentage,
    retainerAmount: total === null ? null : tier1Amount(total, settings.depositPercentage, collect),
    policy: policy ? { version: policy.version, text: policy.text } : null,
    contract: null,
    quoteExpiresAt: null,
  });
});

export default router;
