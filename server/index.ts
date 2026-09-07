import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requireAuth } from "./auth.js";
import { isOriginAllowed } from "./cors.js";
import authRouter from "./routes/auth.js";
import itemsRouter from "./routes/items.js";
import recommendRouter from "./routes/recommend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set. Refusing to start — every session would be unforgeable to check.");
  process.exit(1);
}

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server): allow.
      if (!origin || isOriginAllowed(origin)) {
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
  console.log(`API server listening on http://localhost:${port}`);
});
