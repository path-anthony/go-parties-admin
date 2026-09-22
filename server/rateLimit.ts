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

// POST /api/bookings/direct is public like /api/recommend and writes real
// rows, so it gets the same tight per-IP cap, in its own bucket so a long
// Ask GO conversation can't use up someone's booking attempts.
export const directBookingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a few minutes." },
});

// POST /api/leads/concierge is public and writes a Lead per call, so it
// gets the same tight per-IP cap as direct booking, in its own bucket.
export const conciergeLeadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a few minutes." },
});

// GET /api/items/:id/availability is public and read-only; a storefront
// date picker may call it once per date the customer hovers, so it's loose.
export const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." },
});

// The admin login is one shared password behind everything else in the
// admin, so it gets the same cap as the customer login: 5 failed attempts
// per 15 minutes per IP. Successful logins don't count, so a typo on the
// first try isn't punished, and a locked-out IP gets a clear message rather
// than a generic 401.
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many failed login attempts from this connection. Try again in 15 minutes." },
});

// Customer login is a public password endpoint, so it's the strictest cap
// here: 5 failed attempts per 15 minutes per IP. Successful logins don't
// count, so a customer who gets it right on the third try isn't punished.
export const customerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});

export const customerSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-ups from this connection. Try again in an hour." },
});

// Cancel, reschedule, change-item: signed-in only, but they write real
// rows, so a loose cap still applies.
export const customerActionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many changes at once. Try again in a few minutes." },
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
