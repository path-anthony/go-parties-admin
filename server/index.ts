import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requireAuth } from "./auth.js";
import { isOriginAllowed } from "./cors.js";
import { directBookingLimiter, externalLeadLimiter, recommendLimiter } from "./rateLimit.js";
import authRouter from "./routes/auth.js";
import bookingsRouter from "./routes/bookings.js";
import customerRouter from "./routes/customer.js";
import directBookingsRouter from "./routes/directBookings.js";
import externalLeadsRouter from "./routes/externalLeads.js";
import itemsRouter from "./routes/items.js";
import leadStatusesRouter from "./routes/leadStatuses.js";
import leadsRouter from "./routes/leads.js";
import publicItemsRouter from "./routes/publicItems.js";
import recommendRouter from "./routes/recommend.js";
import unitsRouter from "./routes/units.js";
import { requireWebhookSecret } from "./webhookAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set. Refusing to start — every session would be unforgeable to check.");
  process.exit(1);
}

const app = express();
// Needed for express-rate-limit (and any other req.ip use) to see the real
// client IP instead of Railway's edge proxy — trust exactly one hop.
app.set("trust proxy", 1);

// CORS only applies to the API. Static assets (and the SPA's own JS/CSS,
// which Vite serves with a `crossorigin` attribute — that makes the browser
// send an Origin header even for same-origin loads) must never be evaluated
// against the origin allowlist, or the deployed app's own origin gets
// rejected trying to load its own bundle.
//
// The cors package's `origin` callback only gets the Origin header, not the
// request — so it can't tell "this app calling itself" from "some other
// site". Wrapped per-request here to pass req.headers.host through, since
// same-origin calls (e.g. the frontend's own POST /api/auth/login) must
// always be allowed regardless of ALLOWED_ORIGINS.
app.use("/api", (req, res, next) => {
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server): allow.
      if (!origin || isOriginAllowed(origin, req.headers.host)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })(req, res, next);
});
// Item photos are stored as compressed data URLs in photoUrl (see
// src/lib/photo.ts), so a PATCH can carry a few hundred KB. The default
// 100kb limit would reject them.
app.use(express.json({ limit: "4mb" }));
// Signing secret is ADMIN_PASSWORD itself — see server/auth.ts.
app.use(cookieParser(process.env.ADMIN_PASSWORD));

// Everything below requires a session except:
// - /api/auth: you need to reach login while logged out.
// - /api/health: platform health checks.
// - /api/recommend: called by anonymous customers from the public
//   storefront, so it's public by design and rate limited instead of
//   session-gated (each call costs real money).
// - /api/leads/external: n8n posting website leads, authenticated by a
//   shared secret header instead of a cookie (see server/webhookAuth.ts).
//   Mounted before /api/leads so the session gate never sees it.
// - GET /api/items/:id/availability and POST /api/bookings/direct: the
//   storefront's direct single-item booking, public like /api/recommend and
//   rate limited. Each is mounted ahead of the gated router for its path
//   and defines only its own route, so everything else still hits the gate.
app.use("/api/auth", authRouter);
app.use("/api/items", publicItemsRouter);
app.use("/api/items", requireAuth, itemsRouter);
app.use("/api/leads/external", externalLeadLimiter, requireWebhookSecret, externalLeadsRouter);
app.use("/api/leads", requireAuth, leadsRouter);
app.use("/api/lead-statuses", requireAuth, leadStatusesRouter);
app.use("/api/units", requireAuth, unitsRouter);
app.use("/api/bookings/direct", directBookingLimiter, directBookingsRouter);
app.use("/api/bookings", requireAuth, bookingsRouter);
// Customer accounts: signup and login are public (strictly rate limited
// inside the router), everything else there requires the customer cookie,
// which is a separate session from the admin's (see server/customerAuth.ts).
app.use("/api/customer", customerRouter);
app.use("/api/recommend", recommendLimiter, recommendRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Serves the built Vite frontend so this is one deployable process. If
// dist/ hasn't been built yet (e.g. running the server alone in dev,
// frontend served separately by Vite), this is a no-op.
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof Error && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Not allowed by CORS" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
app.use(handleError);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  // Not necessarily localhost — this same log line runs on Railway too.
  console.log(`API server listening on port ${port}`);
});
