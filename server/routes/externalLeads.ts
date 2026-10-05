import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { getDefaultStatus } from "../leadStatuses.js";
import { safeInline, safeText, stripControl } from "../sanitize.js";

const router = Router();

// Caps on what the website automation may send (the secret keeps strangers
// out; the caps keep one bad payload from storing megabytes or smuggling
// control characters into a record staff read).
const MAX_NAME = 120;
const MAX_CONTACT = 200;
const MAX_OCCASION = 120;
const MAX_NOTES = 2000;

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Lead ingestion from n8n (the marketing website's automation). Auth and
// rate limiting are applied where this is mounted in index.ts. Source is
// fixed to "website" and status to "New" here; n8n doesn't get to choose.
router.post("/", async (req, res) => {
  const { customerName, contact, occasion, notes } = req.body ?? {};

  for (const [field, value, max] of [["customerName", customerName, MAX_NAME], ["contact", contact, MAX_CONTACT], ["occasion", occasion, MAX_OCCASION], ["notes", notes, MAX_NOTES]] as const) {
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > max)) {
      return res.status(400).json({ error: `${field} must be text up to ${max} characters` });
    }
  }
  const name = normalizeText(customerName) ? safeInline(normalizeText(customerName), MAX_NAME) || null : null;
  if (!name) {
    return res.status(400).json({ error: "customerName is required" });
  }
  const contactText = normalizeText(contact) ? stripControl(normalizeText(contact), MAX_CONTACT) || null : null;
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
      occasion: normalizeText(occasion) ? safeInline(normalizeText(occasion), MAX_OCCASION) || null : null,
      notes: normalizeText(notes) ? safeText(normalizeText(notes), MAX_NOTES) || null : null,
    },
  });

  res.status(201).json(lead);
});

export default router;
