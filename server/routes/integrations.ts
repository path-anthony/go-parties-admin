import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { SESSION_COOKIE, requireOwner } from "../auth.js";
import { audit } from "../users.js";
import { signedCookie } from "../sessions.js";
import { authUrl, GoogleError, REDIRECT_URI, SCOPES } from "../google/client.js";
import { ConnectError, beginConnect, calendarsFor, disconnect, finishConnect, googleSettings, spendState } from "../google/connection.js";
import { reconcileCalendar } from "../google/sync.js";
import { safeErr } from "../log.js";
import { stripeStatus } from "../payments.js";
import { stripeConfigured, stripeMode, stripeSecretKey, stripeWebhookSecret } from "../stripe/client.js";
import { mapsConfigured } from "../delivery.js";

const router = Router();

// A read-only status page's data: is each outside service hooked up, and
// what happened to the last thing sent through it. Only yes/no and the last
// result are returned. No key, token, phone number or URL value leaves the
// server.
router.get("/status", async (_req, res) => {
  const account = await getDefaultAccount();
  const has = (name: string) => !!process.env[name]?.trim();

  const twilioParts = {
    accountId: has("TWILIO_ACCOUNT_SID"),
    authToken: has("TWILIO_AUTH_TOKEN"),
    phoneNumber: has("TWILIO_PHONE_NUMBER"),
  };
  const [lastText, lastEmail] = await Promise.all([
    prisma.messageLog.findFirst({ where: { accountId: account.id, channel: "sms" }, orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true, confirmation: true } }),
    prisma.messageLog.findFirst({ where: { accountId: account.id, channel: "email" }, orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true, confirmation: true } }),
  ]);

  const lastRun = await prisma.automationRun.findFirst({ where: { accountId: account.id }, orderBy: { ranAt: "desc" } });
  const needsAttention = await prisma.messageLog.count({ where: { accountId: account.id, status: "failed_final" } });

  const stripe = await stripeStatus(account.id);
  res.json({
    automation: { last: lastRun ? { ranAt: lastRun.ranAt, source: lastRun.source, summary: lastRun.summary } : null, needsAttention },
    // Block T1: online payment and address checking. Mode, last webhook and
    // last error only; never a key.
    stripe: { configured: stripeConfigured(), mode: stripeMode(), parts: { secretKey: stripeSecretKey() !== null, webhookSecret: stripeWebhookSecret() !== null }, lastWebhookAt: stripe.lastWebhookAt, lastError: stripe.lastError },
    maps: { configured: mapsConfigured() },
    texting: { configured: twilioParts.accountId && twilioParts.authToken && twilioParts.phoneNumber, parts: twilioParts, last: lastText },
    email: { configured: has("EMAIL_WEBHOOK_URL"), last: lastEmail },
    storefront: { urlSet: has("STOREFRONT_URL") },
  });
});

// ---- Google Calendar -------------------------------------------------------------
// All behind the admin session (the router is mounted with requireAuth). The
// OAuth round trip is a browser redirect, so the callback carries the admin
// cookie; its state parameter is signed, tied to that session, and single use.

router.get("/google", async (_req, res) => {
  const account = await getDefaultAccount();
  const s = await googleSettings(account.id);
  let calendars: { id: string; summary: string; primary: boolean }[] = [];
  let calendarError: string | null = null;
  if (s.connected && !s.needsReconnect && !s.configProblem) {
    try {
      calendars = (await calendarsFor(account.id)).map((c) => ({ id: c.id, summary: c.summary, primary: c.primary === true }));
    } catch (err) {
      calendarError = err instanceof GoogleError ? err.message : safeErr(err);
    }
  }
  const needsReconnect = (await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { googleNeedsReconnect: true } })).googleNeedsReconnect;
  res.json({ ...s, needsReconnect, calendars, calendarError, redirectUri: REDIRECT_URI, scopes: SCOPES });
});

router.get("/google/start", requireOwner, async (req, res) => {
  const sessionId = signedCookie(req, SESSION_COOKIE);
  if (typeof sessionId !== "string") return res.status(401).json({ error: "Unauthorized" });
  try {
    const { state, clientId } = await beginConnect(sessionId);
    res.redirect(authUrl(state, clientId));
  } catch (err) {
    if (err instanceof ConnectError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Google sends the browser back here. Whatever happens, the admin lands on
// Settings > Integrations with a one-line result in the address.
router.get("/google/callback", requireOwner, async (req, res) => {
  const back = (result: string) => res.redirect(`/settings/integrations?google=${encodeURIComponent(result)}`);
  const sessionId = signedCookie(req, SESSION_COOKIE);
  if (typeof sessionId !== "string") return res.status(401).json({ error: "Unauthorized" });
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (typeof req.query.error === "string") return back(`Google said no: ${req.query.error.slice(0, 80)}`);
  if (!state || !(await spendState(state, sessionId))) return back("That sign-in link was not valid or was already used. Try Connect with Google again.");
  if (!code) return back("Google did not send back a code. Try again.");
  try {
    const { email } = await finishConnect(code);
    await audit("Google Calendar connected", email ?? null);
    return back(`Connected as ${email ?? "the Google account"}.`);
  } catch (err) {
    console.warn("[google] connect failed:", safeErr(err));
    return back(err instanceof ConnectError || err instanceof GoogleError ? err.message : "Connecting to Google did not work. Try again.");
  }
});

router.post("/google/disconnect", requireOwner, async (_req, res) => {
  await disconnect();
  await audit("Google Calendar disconnected");
  res.json({ ok: true });
});

router.patch("/google", requireOwner, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { googleCalendarId?: string | null; googleInvitesCalendarId?: string | null; googleSendInvites?: boolean; googleSyncStage?: string } = {};
  for (const field of ["calendarId", "invitesCalendarId"] as const) {
    if (field in body) {
      const v = body[field];
      if (v !== null && (typeof v !== "string" || v.length > 300)) return res.status(400).json({ error: `${field} must be a calendar id or null` });
      data[field === "calendarId" ? "googleCalendarId" : "googleInvitesCalendarId"] = v === "" ? null : (v as string | null);
    }
  }
  if ("sendInvites" in body) {
    if (typeof body.sendInvites !== "boolean") return res.status(400).json({ error: "sendInvites must be true or false" });
    data.googleSendInvites = body.sendInvites;
  }
  if ("syncStage" in body) {
    if (body.syncStage !== "Confirmed" && body.syncStage !== "Signed") return res.status(400).json({ error: "syncStage must be Confirmed or Signed" });
    data.googleSyncStage = body.syncStage;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "no editable fields provided" });
  const account = await getDefaultAccount();
  await prisma.account.update({ where: { id: account.id }, data });
  await audit("Google Calendar settings changed", Object.keys(data).join(", "));
  res.json(await googleSettings(account.id));
});

router.post("/google/sync", requireOwner, async (_req, res) => {
  res.json(await reconcileCalendar());
});

export default router;
