import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requireAuth } from "./auth.js";
import authRouter from "./routes/auth.js";
import itemsRouter from "./routes/items.js";
import recommendRouter from "./routes/recommend.js";

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set. Refusing to start — every session would be unforgeable to check.");
  process.exit(1);
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server) or a localhost origin: allow.
      if (!origin || LOCALHOST_ORIGIN.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);
app.use(express.json());
// Signing secret is ADMIN_PASSWORD itself — see server/auth.ts.
app.use(cookieParser(process.env.ADMIN_PASSWORD));

app.use("/api/auth", authRouter);
app.use("/api/items", requireAuth, itemsRouter);
app.use("/api/recommend", requireAuth, recommendRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

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
  console.log(`API server listening on http://localhost:${port}`);
});
