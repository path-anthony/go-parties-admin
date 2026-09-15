import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { countFreeUnits } from "../availability.js";
import { prisma } from "../db.js";
import { availabilityLimiter } from "../rateLimit.js";
import { INVALID, normalizeDate } from "../validate.js";

// Public, no session: the storefront asks this before offering a date.
// Mounted on /api/items ahead of the session-gated items router, and only
// this one path is defined here, so everything else still hits the gate.
const router = Router();

router.get("/:id/availability", availabilityLimiter, async (req, res) => {
  const id = String(req.params.id);
  const date = normalizeDate(req.query.date);
  if (date === null || date === INVALID) {
    return res.status(400).json({ error: "date is required, as YYYY-MM-DD" });
  }
  const dateText = date.toISOString().slice(0, 10);

  const account = await getDefaultAccount();
  const item = await prisma.item.findFirst({ where: { id, accountId: account.id }, select: { id: true, name: true } });
  if (!item) {
    return res.status(404).json({ error: "item not found" });
  }

  // An item with no units has no physical pieces to promise. Say so rather
  // than reporting it free.
  const totalUnits = await prisma.unit.count({ where: { itemId: item.id } });
  if (totalUnits === 0) {
    return res.json({
      itemId: item.id,
      date: dateText,
      directBooking: false,
      available: false,
      message: "This item isn't available for direct booking yet.",
    });
  }

  const freeUnits = await countFreeUnits(item.id, dateText);
  res.json({
    itemId: item.id,
    date: dateText,
    directBooking: true,
    available: freeUnits > 0,
    freeUnits,
    totalUnits,
  });
});

export default router;
