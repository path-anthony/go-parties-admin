import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { ContractError, buildContractContent, buildContractPdf, issueContract, pdfLink, signContract, signingWindow } from "../contracts.js";
import { prisma } from "../db.js";
import { notifyContractSigned } from "../notify.js";
import { availabilityLimiter, contractSignLimiter } from "../rateLimit.js";

// The exact words shown beside the two checkboxes, so every page that
// renders the contract says the same thing. Electronic-signature consent
// and agreement to the terms are two separate acts.
const CONSENT_TEXT = "I consent to sign this contract electronically, and I understand my typed name is my legal signature.";
const TERMS_TEXT = "I have read this contract and agree to its terms.";

function fail(res: import("express").Response, err: unknown) {
  if (err instanceof ContractError) return res.status(err.status).json({ error: err.message, reason: err.reason });
  throw err;
}

// ---- public: the customer's side, by unguessable link -----------------

export const publicContractsRouter = Router();

// The signed PDF, by its own unguessable link (this is the link that is
// texted and emailed). Defined first so "pdf" is never taken for a token.
publicContractsRouter.get("/pdf/:downloadToken", availabilityLimiter, async (req, res) => {
  const doc = await prisma.contractDocument.findUnique({ where: { downloadToken: String(req.params.downloadToken) }, select: { pdf: true, sha256: true, signedName: true } });
  if (!doc) return res.status(404).json({ error: "That document link isn't valid." });
  res.setHeader("Content-Type", "application/pdf");
  res.removeHeader("Content-Security-Policy");
  res.setHeader("Content-Disposition", 'inline; filename="signed-contract.pdf"');
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("ETag", `"${doc.sha256}"`);
  res.send(Buffer.from(doc.pdf));
});

// The contract, ready to render: real values merged into the text and the
// live policy. contentHash identifies exactly this text; send it back when
// signing so the customer can only sign what they were shown.
publicContractsRouter.get("/:token", availabilityLimiter, async (req, res) => {
  try {
    const agreement = await prisma.agreement.findUnique({ where: { signingToken: String(req.params.token) }, include: { contractDocument: true } });
    if (!agreement) return res.status(404).json({ error: "This signing link isn't valid." });
    // The link stops working 30 days after the event, and for an unsigned
    // contract on a cancelled, completed or released booking. The signed PDF
    // has its own link and is unaffected.
    const window = await signingWindow(agreement);
    if (window === "expired" || (window === "closed" && !agreement.contractDocument)) return res.status(404).json({ error: "This signing link isn't valid." });

    if (agreement.contractDocument) {
      const doc = agreement.contractDocument;
      return res.json({
        status: "Signed",
        signed: true,
        title: "Event Services Agreement",
        text: doc.text,
        signedName: doc.signedName,
        signedAt: doc.signedAt.toISOString(),
        pdfUrl: agreement.contractUrl ?? pdfLink(doc.downloadToken, req),
      });
    }

    const c = await buildContractContent(agreement.id);
    res.json({
      status: "Sent",
      signed: false,
      title: "Event Services Agreement",
      customerName: c.customerName,
      eventDate: c.eventDate,
      eventTime: c.eventTime,
      address: c.address,
      items: c.lines,
      addons: c.addons,
      total: c.total,
      depositPercentage: c.depositPercentage,
      depositAmount: c.depositAmount,
      balanceAmount: c.balanceAmount,
      cancellationWindowDays: c.cancellationWindowDays,
      policyVersion: c.policyVersion.version,
      sections: c.sections,
      text: c.text,
      contentHash: c.contentHash,
      consentText: CONSENT_TEXT,
      termsText: TERMS_TEXT,
    });
  } catch (err) {
    fail(res, err);
  }
});

// Signs it. Both consent to sign electronically and agreement to the terms
// must be true; they are asked separately. The typed name becomes the
// signature. IP and time are taken from the request, never the body.
publicContractsRouter.post("/:token/sign", contractSignLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 3 || fullName.length > 120 || !fullName.includes(" ")) {
    return res.status(400).json({ error: "Type your full name, first and last.", reason: "name-required" });
  }
  if (body.consentToElectronicSignature !== true) {
    return res.status(400).json({ error: "You need to consent to sign electronically to continue.", reason: "consent-required" });
  }
  if (body.agreeToTerms !== true) {
    return res.status(400).json({ error: "You need to agree to the contract terms to continue.", reason: "terms-required" });
  }
  if (body.contentHash !== undefined && typeof body.contentHash !== "string") {
    return res.status(400).json({ error: "contentHash must be text" });
  }
  try {
    const signed = await signContract(String(req.params.token), {
      fullName,
      consentToElectronicSignature: true,
      agreeToTerms: true,
      contentHash: body.contentHash as string | undefined,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      baseRequest: req,
    });
    // Texts and emails are sent after the signature is safely stored, and
    // never held up or failed by it.
    void notifyContractSigned(signed.content.subject, signed);
    res.status(201).json({
      signed: true,
      signedAt: signed.signedAt.toISOString(),
      signedName: fullName,
      documentId: signed.documentId,
      pdfUrl: signed.pdfUrl,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---- admin ---------------------------------------------------------------

export const adminContractsRouter = Router();

// Makes a contract ready for a booking or design request and returns its
// signing link. Idempotent. (Sending it to the customer is
// POST /api/messages/send.)
adminContractsRouter.post("/issue", async (req, res) => {
  const { bookingId, designRequestId } = req.body ?? {};
  try {
    const issued = await issueContract({
      bookingId: typeof bookingId === "string" ? bookingId : null,
      designRequestId: typeof designRequestId === "string" ? designRequestId : null,
    });
    res.json({ agreementId: issued.agreementId, signingToken: issued.signingToken, link: issued.link, signed: issued.signed });
  } catch (err) {
    fail(res, err);
  }
});

// The unsigned contract as a PDF, for staff to look over. Not stored.
adminContractsRouter.get("/preview/:bookingId.pdf", async (req, res) => {
  const account = await getDefaultAccount();
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.bookingId), accountId: account.id }, select: { id: true } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  try {
    const issued = await issueContract({ bookingId: booking.id });
    const content = await buildContractContent(issued.agreementId);
    const pdf = await buildContractPdf(content);
    res.setHeader("Content-Type", "application/pdf");
  res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Disposition", 'inline; filename="contract-preview.pdf"');
    res.send(Buffer.from(pdf));
  } catch (err) {
    fail(res, err);
  }
});
