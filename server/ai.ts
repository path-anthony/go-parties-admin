import type { Request, RequestHandler, Response } from "express";
import { getDefaultAccount } from "./account.js";
import { isAuthenticated } from "./auth.js";
import { prettyPhone } from "./messageContext.js";
import { getSettings } from "./settings.js";
import { bumpDaily, takeDaily } from "./usage.js";

// One shared budget for every feature that calls the Anthropic API: Ask GO
// (POST /api/recommend) and the package keyword suggestions (POST
// /api/packages/suggest-keywords). Calls made by someone signed in to the
// admin are counted for visibility (usage_counters key ai_admin) but never
// limited, so public traffic can never lock staff out of their own tools.
// Everyone else shares the daily cap in Settings (key ai_public).

// Sets res.locals.isAdmin for the limiter and the gate that follow.
export const markAdmin: RequestHandler = async (req, res, next) => {
  try {
    res.locals.isAdmin = await isAuthenticated(req);
    next();
  } catch (err) {
    next(err);
  }
};

export function restingMessage(phone: string): string {
  return `Ask GO is resting for today. Call or text us${phone ? ` at ${phone}` : ""}.`;
}

export type AiVerdict = { ok: true } | { ok: false; message: string };

// Takes one unit of the shared budget. When the public cap is used up it
// returns the friendly sentence to show instead; nothing is spent.
export async function aiGate(req: Request, res: Response): Promise<AiVerdict> {
  const account = await getDefaultAccount();
  if (res.locals.isAdmin === true || (res.locals.isAdmin === undefined && (await isAuthenticated(req)))) {
    await bumpDaily(account.id, "ai_admin");
    return { ok: true };
  }
  const settings = await getSettings(account.id);
  if (await takeDaily(account.id, "ai_public", settings.aiDailyCap)) return { ok: true };
  console.warn("[ai] public daily cap reached");
  return { ok: false, message: restingMessage(prettyPhone(settings.rushContactPhone ?? process.env.TWILIO_PHONE_NUMBER)) };
}

export async function companyPhone(): Promise<string> {
  const account = await getDefaultAccount();
  const settings = await getSettings(account.id);
  return prettyPhone(settings.rushContactPhone ?? process.env.TWILIO_PHONE_NUMBER);
}
