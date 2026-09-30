import { type Response, Router } from "express";
import { BidError, askQuestion, confirmSet, declineBid, getBidPage, submitBid } from "../bids.js";
import { bidReadLimiter, bidWriteLimiter } from "../rateLimit.js";

// The crew gig page's API, public, by the offer's unguessable token. Shapes
// are the locked contract with the storefront (see server/bids.ts). Errors
// are { error, reason } with reason in deadline-passed, already-filled,
// bid-invalid, not-open, rate-limited; an unknown or expired link is a 404.

function fail(res: Response, err: unknown) {
  if (err instanceof BidError) return res.status(err.status).json(err.reason ? { error: err.message, reason: err.reason } : { error: err.message });
  throw err;
}

export function makeBidsRouter(limiters: { read: typeof bidReadLimiter; write: typeof bidWriteLimiter } = { read: bidReadLimiter, write: bidWriteLimiter }) {
  const router = Router();

  router.get("/:token", limiters.read, async (req, res) => {
    try {
      const page = await getBidPage(String(req.params.token));
      if (!page) return res.status(404).json({ error: "This link isn't valid." });
      res.setHeader("Cache-Control", "no-store");
      res.json(page);
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/:token/bid", limiters.write, async (req, res) => {
    try {
      res.json(await submitBid(String(req.params.token), req.body));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/:token/decline", limiters.write, async (req, res) => {
    try {
      res.json(await declineBid(String(req.params.token)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/:token/confirm", limiters.write, async (req, res) => {
    try {
      res.json(await confirmSet(String(req.params.token)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/:token/question", limiters.write, async (req, res) => {
    try {
      res.json(await askQuestion(String(req.params.token), (req.body ?? {}).text));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

export default makeBidsRouter();
