// Block A4: the tier endpoint has its own limiter, separate from the hold's.
// Pure HTTP against the limiters with stand-in handlers: no database.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { directBookingLimiter, tierLimiter } from "../rateLimit.js";

let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;

before(() => {
  const app = express();
  app.set("trust proxy", 1);
  app.post("/api/bookings/tier", tierLimiter, (_req, res) => res.json({ tier: 1 }));
  app.post("/api/bookings/direct", directBookingLimiter, (_req, res) => res.status(201).json({ ok: true }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

const post = (path: string) => fetch(`${base}${path}`, { method: "POST" });

test("twenty tier calls in a row succeed", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await post("/api/bookings/tier")).status, 200, `call ${i + 1}`);
});

test("the hold still refuses the sixth attempt in an hour, and tier calls did not count against it", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/bookings/direct")).status, 201, `hold ${i + 1}`);
  const sixth = await post("/api/bookings/direct");
  assert.equal(sixth.status, 429);
  const body = (await sixth.json()) as { error: string; reason: string };
  assert.equal(body.reason, "rate-limited");
  assert.match(body.error, /Too many booking attempts/);
  // Pricing still works after the hold limit is hit.
  assert.equal((await post("/api/bookings/tier")).status, 200);
});

test("the tier limiter refuses the sixty-first call with the same 429 shape", async () => {
  let last = 200;
  let body: { error?: string; reason?: string } = {};
  for (let i = 0; i < 45; i++) {
    const r = await post("/api/bookings/tier");
    last = r.status;
    if (last === 429) {
      body = (await r.json()) as typeof body;
      break;
    }
  }
  assert.equal(last, 429, "21 earlier calls plus these cross 60");
  assert.equal(body.reason, "rate-limited");
  assert.match(body.error ?? "", /Too many pricing requests/);
});
