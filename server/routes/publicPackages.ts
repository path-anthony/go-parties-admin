import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { availabilityLimiter } from "../rateLimit.js";

// Public, no session: the storefront asks for the published packages of
// one occasion. Mounted on /api/packages ahead of the session-gated
// packages router and defines only this path, so everything else there
// still hits the gate. The select is the allowlist of public fields.
const router = Router();

router.get("/public", availabilityLimiter, async (req, res) => {
  const occasion = typeof req.query.occasion === "string" ? req.query.occasion.trim() : "";
  if (!occasion) {
    return res.status(400).json({ error: "occasion is required" });
  }

  const account = await getDefaultAccount();
  const packages = await prisma.package.findMany({
    where: { accountId: account.id, status: "Published", occasion },
    orderBy: [{ price: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      theme: true,
      occasion: true,
      photoUrl: true,
      items: {
        select: {
          quantity: true,
          item: { select: { id: true, name: true, category: true, price: true, priceUnit: true } },
        },
        orderBy: { item: { name: "asc" } },
      },
    },
  });

  res.json({
    occasion,
    packages: packages.map(({ price, items, ...pkg }) => ({
      ...pkg,
      price: Number(price),
      items: items.map(({ quantity, item }) => ({
        itemId: item.id,
        name: item.name,
        category: item.category,
        price: item.price === null ? null : Number(item.price),
        priceUnit: item.priceUnit,
        quantity,
      })),
    })),
  });
});

export default router;
