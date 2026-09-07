import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import itemsRouter from "./routes/items.js";
import recommendRouter from "./routes/recommend.js";

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server) or a localhost origin: allow.
      // Local dev only — do not widen this without adding real auth first.
      if (!origin || LOCALHOST_ORIGIN.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  }),
);
app.use(express.json());

app.use("/api/items", itemsRouter);
app.use("/api/recommend", recommendRouter);

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
