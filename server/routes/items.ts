import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const router = Router();

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const items = await prisma.item.findMany({
    where: { accountId: account.id },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  res.json(items);
});

router.post("/", async (req, res) => {
  const { name, category, price, priceUnit, notes, photoUrl } = req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required" });
  }
  if (typeof category !== "string" || category.trim() === "") {
    return res.status(400).json({ error: "category is required" });
  }
  if (price !== undefined && price !== null && price !== "" && Number.isNaN(Number(price))) {
    return res.status(400).json({ error: "price must be a number" });
  }

  const account = await getDefaultAccount();
  const item = await prisma.item.create({
    data: {
      accountId: account.id,
      name: name.trim(),
      category: category.trim(),
      price: price === undefined || price === null || price === "" ? null : Number(price),
      priceUnit: typeof priceUnit === "string" && priceUnit.trim() !== "" ? priceUnit.trim() : null,
      notes: typeof notes === "string" && notes.trim() !== "" ? notes.trim() : null,
      photoUrl: typeof photoUrl === "string" && photoUrl.trim() !== "" ? photoUrl.trim() : null,
    },
  });

  res.status(201).json(item);
});

export default router;
