import "dotenv/config";
import cors from "cors";
import express from "express";
import itemsRouter from "./routes/items.js";
import recommendRouter from "./routes/recommend.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/items", itemsRouter);
app.use("/api/recommend", recommendRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
