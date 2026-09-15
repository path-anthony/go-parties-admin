import rateLimit from "express-rate-limit";

// /api/recommend is public (no session required) and each call costs real
// money via the Claude API, so it needs its own per-IP limit independent of
// the auth gate that protects everything else. Generous enough for a real
// visitor trying a few themes, tight enough to block a tight loop.
export const recommendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a few minutes." },
});

// /api/leads/external is trusted server-to-server traffic from n8n, so the
// cap is loose: real lead volume is nowhere near a lead a second, but a
// misconfigured retry loop would be, and this stops it filling Bookings.
export const externalLeadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." },
});
