import { Router } from "express";
import { safeErr } from "../log.js";
import { applyStripeEvent } from "../payments.js";
import { stripeWebhookSecret, verifyWebhookSignature, type StripeEventBody } from "../stripe/client.js";

// Block T1. POST /api/webhooks/stripe. Mounted with express.raw so the
// signature is checked over the exact bytes Stripe sent. Every event is
// recorded by Stripe's id before it is applied, so a replay is a no-op. A
// bad signature is a 400 and nothing is written. The handler answers 200
// once the event is stored, even if applying it failed (the error is kept on
// the event and the account for the Integrations card), because Stripe
// retries anything else and the replay would be refused as a duplicate.

const router = Router();

router.post("/", async (req, res) => {
  const secret = stripeWebhookSecret();
  if (!secret) return res.status(503).json({ error: "Online payment is not set up." });
  const raw = Buffer.isBuffer(req.body) ? req.body : typeof req.body === "string" ? Buffer.from(req.body) : null;
  if (!raw) return res.status(400).json({ error: "A raw body is required." });
  const check = verifyWebhookSignature(raw, req.get("stripe-signature"), secret);
  if (!check.ok) {
    console.warn(`[stripe] webhook refused: ${check.why}`);
    return res.status(400).json({ error: "Bad signature." });
  }
  let event: StripeEventBody;
  try {
    event = JSON.parse(raw.toString("utf8")) as StripeEventBody;
  } catch {
    return res.status(400).json({ error: "The event could not be read." });
  }
  if (!event || typeof event.id !== "string" || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || typeof event.type !== "string" || !event.data?.object) return res.status(400).json({ error: "That is not a Stripe event." });
  try {
    const result = await applyStripeEvent(event);
    res.json({ received: true, duplicate: result.duplicate, handled: result.handled });
  } catch (err) {
    console.error("[stripe] webhook could not be stored:", safeErr(err));
    res.status(500).json({ error: "The event could not be stored." });
  }
});

export default router;
