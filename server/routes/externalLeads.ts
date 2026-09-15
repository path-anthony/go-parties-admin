import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { getDefaultStatus } from "../leadStatuses.js";

const router = Router();

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Lead ingestion from n8n (the marketing website's automation). Auth and
// rate limiting are applied where this is mounted in index.ts. Source is
// fixed to "website" and status to "New" here; n8n doesn't get to choose.
router.post("/", async (req, res) => {
  const { customerName, contact, occasion, notes } = req.body ?? {};

  const name = normalizeText(customerName);
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const contactText = normalizeText(contact);
  if (!contactText) {
    return res.status(400).json({ error: "contact is required" });
  }

  const account = await getDefaultAccount();
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      source: "website",
      status: await getDefaultStatus(account.id),
      customerName: name,
      contact: contactText,
      occasion: normalizeText(occasion),
      notes: normalizeText(notes),
    },
  });

  res.status(201).json(lead);
});

export default router;
