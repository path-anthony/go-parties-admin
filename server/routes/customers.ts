import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const router = Router();

const MAX_RESULTS = 10;

// Find a customer account by name, phone or email, for the admin's New
// booking. Read only, and it returns only what the booking needs: never
// the password hash. Phone matches on digits, so "(860) 555-0100" finds
// 8605550100. Nothing is returned for a blank or one-character search.
router.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.json([]);
  const digits = q.replace(/\D/g, "");
  const account = await getDefaultAccount();
  const customers = await prisma.customer.findMany({
    where: {
      accountId: account.id,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    },
    select: { id: true, name: true, phone: true, email: true },
    orderBy: { createdAt: "desc" },
    take: MAX_RESULTS,
  });
  res.json(customers);
});

export default router;
