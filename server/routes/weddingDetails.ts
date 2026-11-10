import { Router, type Response } from "express";
import type { Customer } from "../../src/generated/prisma/client.js";
import { getDefaultAccount } from "../account.js";
import { requireCustomer } from "../customerAuth.js";
import { customerActionLimiter, weddingSaveLimiter } from "../rateLimit.js";
import { renderWeddingPrint } from "../weddingDetails/print.js";
import { WeddingError, customerView, printView, requestChange, saveAnswers, setWeddingOverride, staffView, submitDetails, unlockDetails } from "../weddingDetails/store.js";

// Block A11: the wedding details questionnaire.
//
// Customer routes live under /api/customer/bookings/:id/wedding-details and
// answer 404 for anything that is not this customer's own wedding booking.
// Staff routes live under /api/bookings, behind the admin session.

const NOT_FOUND = { error: "booking not found" };

function answer(res: Response, run: () => Promise<unknown>) {
  return run()
    .then((body) => (body === null ? res.status(404).json(NOT_FOUND) : res.json(body)))
    .catch((err: unknown) => {
      if (err instanceof WeddingError) return res.status(err.status).json({ error: err.message, reason: err.reason, ...err.extra });
      throw err;
    });
}

export const customerWeddingRouter = Router({ mergeParams: true });
customerWeddingRouter.use(requireCustomer);

const params = (req: { params: Record<string, unknown> }, res: Response) => ({ bookingId: String(req.params.id), customer: res.locals.customer as Customer });

customerWeddingRouter.get("/", (req, res) => {
  const { bookingId, customer } = params(req, res);
  return answer(res, () => customerView(bookingId, customer.id));
});

// The form saves as the customer goes, so this has its own, roomier limit.
customerWeddingRouter.patch("/", weddingSaveLimiter, (req, res) => {
  const { bookingId, customer } = params(req, res);
  return answer(res, () => saveAnswers(bookingId, customer.id, (req.body ?? {}).answers));
});

customerWeddingRouter.post("/submit", customerActionLimiter, (req, res) => {
  const { bookingId, customer } = params(req, res);
  return answer(res, () => submitDetails(bookingId, customer.id, customer));
});

customerWeddingRouter.post("/request-change", customerActionLimiter, (req, res) => {
  const { bookingId, customer } = params(req, res);
  return answer(res, () => requestChange(bookingId, customer.id, (req.body ?? {}).note));
});

export const adminWeddingRouter = Router();

adminWeddingRouter.get("/:id/wedding-details", async (req, res) => {
  const account = await getDefaultAccount();
  return answer(res, () => staffView(String(req.params.id), account.id));
});

adminWeddingRouter.post("/:id/wedding-details/unlock", async (req, res) => {
  const account = await getDefaultAccount();
  return answer(res, () => unlockDetails(String(req.params.id), account.id, (req.body ?? {}).reason));
});

// null is back to the automatic rule.
adminWeddingRouter.patch("/:id/wedding", async (req, res) => {
  const account = await getDefaultAccount();
  return answer(res, () => setWeddingOverride(String(req.params.id), account.id, (req.body ?? {}).weddingOverride));
});

adminWeddingRouter.get("/:id/wedding-details/print", async (req, res) => {
  const account = await getDefaultAccount();
  const view = await printView(String(req.params.id), account.id);
  if (!view) return res.status(404).json(NOT_FOUND);
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(renderWeddingPrint(view));
});
