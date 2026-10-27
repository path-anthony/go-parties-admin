import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { ContractError, buildContractContent, buildContractPdf, pdfLink, prepareContract, signContract, signingWindow } from "../contracts.js";
import { buildGoDocument, contractLogo, goReadinessFor } from "../contract/goLoad.js";
import { buildGoPdf } from "../contract/goPdf.js";
import { getSettings } from "../settings.js";
import { queueGoogleSync } from "../google/sync.js";
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

// The company logo on the GO contract: the uploaded one or the built-in
// placeholder. Public, since the contract page shows it. Defined before
// "/:token" so "logo.png" is never read as a token.
publicContractsRouter.get("/logo.png", availabilityLimiter, async (_req, res) => {
  const account = await getDefaultAccount();
  const logo = await contractLogo(account.id);
  res.setHeader("Content-Type", logo.type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("ETag", `"${logo.etag}"`);
  res.send(logo.bytes);
});

// The contract, ready to render: real values merged into the text and the
// live policy. For the GO contract (format go-v2) the reply carries the whole
// document in the locked shape the storefront renders, built field by field
// in server/contract/goDocument.ts. Agreements on the original layout answer
// exactly as before. contentHash identifies exactly this text; send it back when
// signing so the customer can only sign what they were shown.
// The contract as the customer reads it, by agreement. Shared by the public
// signing link and the portal's own contract page (Block T1), so both answer
// in the one locked shape.
export async function contractView(agreement: { id: string; bookingId: string | null; designRequestId: string | null; format: string | null; contractUrl: string | null; contractDocument: { text: string; signedName: string; signedAt: Date; downloadToken: string; format: string | null; documentJson: unknown } | null }, req: import("express").Request): Promise<{ status: number; body: Record<string, unknown> }> {
  // The link stops working 30 days after the event, and for an unsigned
  // contract on a cancelled, completed or released booking. The signed PDF
  // has its own link and is unaffected.
  const window = await signingWindow(agreement);
  if (window === "expired" || (window === "closed" && !agreement.contractDocument)) return { status: 404, body: { error: "This signing link isn't valid." } };

  if (agreement.contractDocument) {
    const doc = agreement.contractDocument;
    const base = {
      status: "Signed",
      signed: true,
      title: "Event Services Agreement",
      text: doc.text,
      signedName: doc.signedName,
      signedAt: doc.signedAt.toISOString(),
      pdfUrl: agreement.contractUrl ?? pdfLink(doc.downloadToken, req),
    };
    // The signed GO document is served as it was signed, all three
    // signature lines in it, never rebuilt.
    if (doc.format === "go-v2" && doc.documentJson) return { status: 200, body: { ...base, format: "go-v2", title: "Service Contract and Retainer Agreement", document: doc.documentJson } };
    return { status: 200, body: base };
  }

  if (agreement.format === "go-v2") {
    const go = await buildGoDocument(agreement.id);
    const d = go.document;
    const cents = (v: number | "-" | null) => (typeof v === "number" ? v / 100 : null);
    return {
      status: 200,
      body: {
        status: "Sent",
        signed: false,
        format: "go-v2",
        title: d.terms.pageHeader ?? "Service Contract and Retainer Agreement",
        customerName: d.client.nameOrg,
        eventDate: d.event.date,
        eventTime: d.event.timeFromTo,
        address: d.event.venueAddress,
        total: cents(d.payment.total),
        depositPercentage: d.payment.retainerPercent,
        depositAmount: cents(d.payment.retainerAmount),
        balanceAmount: cents(d.payment.balance),
        sections: [],
        text: "",
        contentHash: go.contentHash,
        consentText: d.acceptance.esignLabel ?? CONSENT_TEXT,
        termsText: TERMS_TEXT,
        document: d,
      },
    };
  }

  const c = await buildContractContent(agreement.id);
  return {
    status: 200,
    body: {
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
    },
  };
}

publicContractsRouter.get("/:token", availabilityLimiter, async (req, res) => {
  try {
    const agreement = await prisma.agreement.findUnique({ where: { signingToken: String(req.params.token) }, include: { contractDocument: true } });
    if (!agreement) return res.status(404).json({ error: "This signing link isn't valid." });
    const view = await contractView(agreement, req);
    res.status(view.status).json(view.body);
  } catch (err) {
    fail(res, err);
  }
});

// Signs it. Both consent to sign electronically and agreement to the terms
// must be true; they are asked separately. The typed name becomes the
// signature. IP and time are taken from the request, never the body.
// Reads and checks the sign request body. Shared with the portal's sign
// route (Block T1). Returns the refusal to send, or the clean input.
export function parseSignBody(body: Record<string, unknown>, isGo: boolean): { status: number; body: Record<string, unknown> } | { fullName: string; additionalSignerName: string | null; contentHash: string | undefined } {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 3 || fullName.length > 120 || !fullName.includes(" ")) {
    return { status: 400, body: { error: "Type your full name, first and last.", reason: "name-required" } };
  }
  // The GO contract has one checkbox: consenting to sign electronically is
  // agreeing to the terms (its text says so). The original layout asks twice.
  const consented = body.consentToElectronicSignature === true || (isGo && body.esignConsent === true);
  const agreed = body.agreeToTerms === true || (isGo && body.esignConsent === true);
  if (!consented) return { status: 400, body: { error: "You need to consent to sign electronically to continue.", reason: "consent-required" } };
  if (!agreed) return { status: 400, body: { error: "You need to agree to the contract terms to continue.", reason: "terms-required" } };
  let additionalSignerName: string | null = null;
  if (body.additionalSignerName !== undefined && body.additionalSignerName !== null && body.additionalSignerName !== "") {
    if (typeof body.additionalSignerName !== "string" || body.additionalSignerName.trim().length > 120) {
      return { status: 400, body: { error: "The additional signer's name can be up to 120 characters.", reason: "name-required" } };
    }
    additionalSignerName = body.additionalSignerName.trim().replace(/\s+/g, " ") || null;
  }
  if (body.contentHash !== undefined && typeof body.contentHash !== "string") return { status: 400, body: { error: "contentHash must be text" } };
  return { fullName, additionalSignerName, contentHash: body.contentHash as string | undefined };
}

publicContractsRouter.post("/:token/sign", contractSignLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 3 || fullName.length > 120 || !fullName.includes(" ")) {
    return res.status(400).json({ error: "Type your full name, first and last.", reason: "name-required" });
  }
  // The GO contract has one checkbox: consenting to sign electronically is
  // agreeing to the terms (its text says so). The original layout asks twice.
  const agreementFormat = (await prisma.agreement.findUnique({ where: { signingToken: String(req.params.token) }, select: { format: true } }))?.format ?? null;
  const isGo = agreementFormat === "go-v2";
  const consented = body.consentToElectronicSignature === true || (isGo && body.esignConsent === true);
  const agreed = body.agreeToTerms === true || (isGo && body.esignConsent === true);
  if (!consented) {
    return res.status(400).json({ error: "You need to consent to sign electronically to continue.", reason: "consent-required" });
  }
  if (!agreed) {
    return res.status(400).json({ error: "You need to agree to the contract terms to continue.", reason: "terms-required" });
  }
  let additionalSignerName: string | null = null;
  if (body.additionalSignerName !== undefined && body.additionalSignerName !== null && body.additionalSignerName !== "") {
    if (typeof body.additionalSignerName !== "string" || body.additionalSignerName.trim().length > 120) {
      return res.status(400).json({ error: "The additional signer's name can be up to 120 characters.", reason: "name-required" });
    }
    additionalSignerName = body.additionalSignerName.trim().replace(/\s+/g, " ") || null;
  }
  if (body.contentHash !== undefined && typeof body.contentHash !== "string") {
    return res.status(400).json({ error: "contentHash must be text" });
  }
  try {
    const signed = await signContract(String(req.params.token), {
      fullName,
      additionalSignerName,
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
    if (signed.content.subject.bookingId) queueGoogleSync(signed.content.subject.bookingId);
    res.status(201).json({
      signed: true,
      signedAt: signed.signedAt.toISOString(),
      signedName: fullName,
      documentId: signed.documentId,
      pdfUrl: signed.pdfUrl,
      // The GO contract comes back whole, all three signature lines in it.
      ...("format" in signed && signed.format === "go-v2" ? { format: "go-v2", document: signed.document } : {}),
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---- admin ---------------------------------------------------------------

export const adminContractsRouter = Router();

// Makes a contract ready for a booking or design request and returns its
// signing link. Idempotent. This does not send anything and does not mark the
// contract Sent; sending it to the customer is POST /api/messages/send.
adminContractsRouter.post("/issue", async (req, res) => {
  const { bookingId, designRequestId } = req.body ?? {};
  try {
    const issued = await prepareContract({
      bookingId: typeof bookingId === "string" ? bookingId : null,
      designRequestId: typeof designRequestId === "string" ? designRequestId : null,
    });
    res.json({ agreementId: issued.agreementId, signingToken: issued.signingToken, link: issued.link, signed: issued.signed });
  } catch (err) {
    fail(res, err);
  }
});

// Which contract a booking gets, and whether it is ready to send: the
// booking popup shows this next to the send button.
adminContractsRouter.get("/status/:bookingId", async (req, res) => {
  const account = await getDefaultAccount();
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.bookingId), accountId: account.id }, select: { id: true, agreement: { select: { format: true, signingToken: true, contractStatus: true, goSignerName: true, goSignedAt: true } } } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  const settings = await getSettings(account.id);
  const a = booking.agreement;
  // Decided already, or what the first send would decide.
  const format = a?.format === "go-v2" ? "go-v2" : a?.signingToken || a?.format ? "sections" : settings.useGoContract ? "go-v2" : "sections";
  const readiness = format === "go-v2" ? await goReadinessFor(booking.id) : null;
  res.json({ format, decided: !!a?.signingToken, readiness, goSigner: a?.goSignerName ? { printedName: a.goSignerName, signedAt: a.goSignedAt?.toISOString() ?? null } : null, goSignerConfigured: !!settings.authorizedSignerName && !!settings.authorizedSignerTitle });
});

// The unsigned contract as a PDF, for staff to look over. Not stored. Looking
// is not sending: this never marks the contract Sent and never starts the
// 48-hour reminder clock.
adminContractsRouter.get("/preview/:bookingId.pdf", async (req, res) => {
  const account = await getDefaultAccount();
  const booking = await prisma.booking.findFirst({ where: { id: String(req.params.bookingId), accountId: account.id }, select: { id: true } });
  if (!booking) return res.status(404).json({ error: "booking not found" });
  try {
    const issued = await prepareContract({ bookingId: booking.id });
    let pdf: Uint8Array;
    if (issued.format === "go-v2") {
      const go = await buildGoDocument(issued.agreementId);
      const logo = await contractLogo(account.id);
      pdf = await buildGoPdf({ doc: go.document, logo: { bytes: logo.bytes, type: logo.type } });
    } else {
      const content = await buildContractContent(issued.agreementId);
      pdf = await buildContractPdf(content);
    }
    res.setHeader("Content-Type", "application/pdf");
  res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Disposition", 'inline; filename="contract-preview.pdf"');
    res.send(Buffer.from(pdf));
  } catch (err) {
    fail(res, err);
  }
});
