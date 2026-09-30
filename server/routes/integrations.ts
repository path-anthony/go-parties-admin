import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

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

  res.json({
    texting: { configured: twilioParts.accountId && twilioParts.authToken && twilioParts.phoneNumber, parts: twilioParts, last: lastText },
    email: { configured: has("EMAIL_WEBHOOK_URL"), last: lastEmail },
    storefront: { urlSet: has("STOREFRONT_URL") },
  });
});

export default router;
