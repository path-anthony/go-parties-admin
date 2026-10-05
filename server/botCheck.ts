import type { Request, RequestHandler } from "express";
import { getDefaultAccount } from "./account.js";
import { ipHash } from "./log.js";
import { getSettings } from "./settings.js";

// Do-it-yourself bot protection for the public write routes. The storefront
// sends two optional fields: hpField, a hidden input real people never fill,
// and formStartedAt, when the form (or cart) was started in milliseconds. A
// filled honeypot, or a form that was "finished" under 3 seconds after it was
// started, is a script. Missing fields are allowed until the account turns on
// "Require bot check fields" in Settings.

export const MIN_FORM_MS = 3000;
export const BOT_MESSAGE = "Something went wrong. Please try again in a moment, or call or text us.";

export type BotVerdict = { ok: true } | { ok: false; why: "honeypot" | "too-fast" | "bad-timestamp" | "fields-required" };

export function checkBotFields(body: Record<string, unknown>, opts: { required: boolean; now?: number; minAgeApplies?: boolean }): BotVerdict {
  const now = opts.now ?? Date.now();
  const hp = body.hpField;
  const started = body.formStartedAt;
  const hasHp = hp !== undefined && hp !== null;
  const hasStart = started !== undefined && started !== null;
  if (opts.required && (!hasHp || !hasStart)) return { ok: false, why: "fields-required" };
  if (hasHp && !(typeof hp === "string" && hp === "")) return { ok: false, why: "honeypot" };
  if (hasStart && opts.minAgeApplies !== false) {
    const ms = typeof started === "number" ? started : typeof started === "string" && started.trim() !== "" ? Number(started) : NaN;
    if (!Number.isFinite(ms)) return { ok: false, why: "bad-timestamp" };
    if (now - ms < MIN_FORM_MS) return { ok: false, why: "too-fast" };
  }
  return { ok: true };
}

// Express middleware. `minAgeApplies` lets a route say the timestamp does not
// mean "form opened" for this request (Ask GO's first message).
export function botCheck(route: string, options: { minAgeApplies?: (req: Request) => boolean } = {}): RequestHandler {
  return async (req, res, next) => {
    try {
      // Staff signed in to the admin use the same routes (the admin's Ask GO
      // panel) and send no bot fields; they are never checked.
      if (res.locals.isAdmin === true) return next();
      const account = await getDefaultAccount();
      const settings = await getSettings(account.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const verdict = checkBotFields(body, { required: settings.requireBotCheck, minAgeApplies: options.minAgeApplies ? options.minAgeApplies(req) : true });
      if (!verdict.ok) {
        // Redacted: the reason and a keyed hash of the address, nothing typed.
        console.warn(`[botcheck] ${route} refused: ${verdict.why} (client ${ipHash(req.ip).slice(0, 8)})`);
        return res.status(400).json({ error: BOT_MESSAGE, reason: "bot-check" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
