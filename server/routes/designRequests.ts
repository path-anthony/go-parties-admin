import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { normalizeText } from "../validate.js";

const STATUSES = ["Open", "Converted", "Dismissed"] as const;
const MAX_NOTES = 2000;

const router = Router();

function serialize<T extends { total: unknown }>(request: T) {
  return { ...request, total: request.total === null ? null : Number(request.total) };
}

// The review queue. Newest first; ?status=Open (or Converted, Dismissed)
// narrows it. Turning a request into a booking is not here: staff do that
// in New booking, which is given the request's id, so the same locks and
// the agreement rule apply. This only reads, dismisses and takes notes.
router.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  }
  const account = await getDefaultAccount();
  const requests = await prisma.designRequest.findMany({
    where: { accountId: account.id, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests.map(serialize));
});

router.patch("/:id", async (req, res) => {
  const body = req.body ?? {};
  const account = await getDefaultAccount();
  const existing = await prisma.designRequest.findFirst({ where: { id: String(req.params.id), accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "design request not found" });

  const data: { notes?: string | null; status?: string } = {};
  if ("notes" in body) {
    const notes = body.notes === null ? null : typeof body.notes === "string" ? normalizeText(body.notes) : undefined;
    if (notes === undefined || (notes !== null && notes.length > MAX_NOTES)) {
      return res.status(400).json({ error: `notes must be text up to ${MAX_NOTES} characters` });
    }
    data.notes = notes;
  }
  if ("status" in body) {
    // Converted is only ever set by making the booking; the only manual
    // moves are to Dismissed and back to Open.
    if (body.status !== "Dismissed" && body.status !== "Open") {
      return res.status(400).json({ error: "status can be set to Dismissed or Open. Converted happens when the booking is made." });
    }
    if (existing.status === "Converted") {
      return res.status(409).json({ error: "This request already became a booking." });
    }
    data.status = body.status;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "no editable fields provided" });

  const updated = await prisma.designRequest.update({ where: { id: existing.id }, data });
  res.json(serialize(updated));
});

export default router;
