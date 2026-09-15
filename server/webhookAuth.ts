import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Server-to-server auth for n8n (the marketing site's automation), which
// is a machine calling in, not a logged-in browser, so it can't use the
// admin session cookie. Deliberately its own secret rather than
// ADMIN_PASSWORD: rotating one shouldn't break the other.
export const requireWebhookSecret: RequestHandler = (req, res, next) => {
  const expected = process.env.N8N_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[webhook] N8N_WEBHOOK_SECRET is not set; refusing external lead");
    return res.status(503).json({ error: "External lead ingestion is not configured" });
  }
  const provided = req.get(WEBHOOK_SECRET_HEADER);
  if (typeof provided !== "string" || !secretsMatch(provided, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};
