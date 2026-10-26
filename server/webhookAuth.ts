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
//
// Rotation: while the secret is being changed, N8N_WEBHOOK_SECRET_PREVIOUS
// may hold the old value and both are accepted, so n8n's workflows can be
// updated one at a time without a lost call. Unset it once they all carry
// the new one.
export function acceptedWebhookSecrets(): string[] {
  return [process.env.N8N_WEBHOOK_SECRET, process.env.N8N_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => typeof s === "string" && s.length > 0);
}

export const requireWebhookSecret: RequestHandler = (req, res, next) => {
  const accepted = acceptedWebhookSecrets();
  if (accepted.length === 0) {
    console.error("[webhook] N8N_WEBHOOK_SECRET is not set; refusing external lead");
    return res.status(503).json({ error: "External lead ingestion is not configured" });
  }
  const provided = req.get(WEBHOOK_SECRET_HEADER);
  if (typeof provided !== "string" || !accepted.some((expected) => secretsMatch(provided, expected))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};
