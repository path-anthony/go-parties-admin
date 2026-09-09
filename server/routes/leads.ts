import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";

const router = Router();

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const leads = await prisma.lead.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(leads);
});

export default router;
