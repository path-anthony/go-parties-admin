import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { BOOKING_VIEWS, STATUS_WORDS } from "../bookingsList.js";
import { loadBookingSummary, loadBookingsList } from "../bookingsLoad.js";

// Block F3b. The Bookings list and the booking popup's summary. Staff only:
// mounted behind the admin session, ahead of the bookings router.

const router = Router();

router.get("/list", async (_req, res) => {
  const account = await getDefaultAccount();
  const list = await loadBookingsList(account.id);
  res.json({ today: list.today, views: BOOKING_VIEWS.map((v) => ({ ...v, count: list.counts[v.key] })), statuses: STATUS_WORDS, rows: list.rows });
});

router.get("/:id/summary", async (req, res) => {
  const account = await getDefaultAccount();
  const summary = await loadBookingSummary(account.id, String(req.params.id));
  if (!summary) return res.status(404).json({ error: "booking not found" });
  res.json(summary);
});

export default router;
