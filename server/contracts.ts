import { createHash, randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";
import { currentPolicy } from "./policy.js";
import { getSettings } from "./settings.js";
import { mergeFields } from "./tokens.js";

export { mergeFields };

// The self-hosted contract. One contract per Agreement: the customer is
// sent an unguessable signing link, reads the merged text, types their
// name and consents to sign electronically, and the signed PDF is
// generated and stored for good (in the database, like photos: the app has
// no persistent disk). The Agreement's reserved fields carry the state:
// provider "self-hosted", the ContractDocument id, status Sent then Signed,
// and a link to the stored PDF.

export class ContractError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export const CONTRACT_PROVIDER = "self-hosted";

// The merge fields a policy text (and the contract around it) may use.
export const MERGE_FIELDS = [
  "customer_name",
  "event_date",
  "event_time",
  "event_address",
  "total",
  "deposit_percentage",
  "deposit_amount",
  "balance_amount",
  "cancellation_window_days",
] as const;

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function longDate(dateText: string): string {
  return new Date(`${dateText}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export type ContractContent = {
  agreementId: string;
  subject: { bookingId: string | null; designRequestId: string | null };
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  eventDate: string;
  eventTime: string | null;
  address: string | null;
  lines: { name: string; quantity: number; unitPrice: number | null }[];
  addons: { itemName: string; groupName: string; addonName: string; priceDelta: number; quantity: number }[];
  total: number | null;
  depositPercentage: number;
  depositAmount: number | null;
  balanceAmount: number | null;
  balancePaymentPreference: string;
  cancellationWindowDays: number;
  policyVersion: { id: string; version: number };
  sections: { heading: string; body: string }[];
  text: string;
  contentHash: string;
};

type Subject = {
  customerName: string;
  phone: string | null;
  email: string | null;
  eventDate: Date;
  eventTime: string | null;
  address: string | null;
  total: number | null;
  balancePaymentPreference: string;
  lines: ContractContent["lines"];
  addons: ContractContent["addons"];
};

async function loadSubject(agreement: { bookingId: string | null; designRequestId: string | null }): Promise<Subject> {
  if (agreement.bookingId) {
    const b = await prisma.booking.findUniqueOrThrow({
      where: { id: agreement.bookingId },
      include: {
        units: { include: { unit: { select: { item: { select: { id: true, name: true, price: true } } } } } },
        gigs: { where: { status: { not: "Cancelled" } }, select: { itemId: true, itemName: true } },
        addons: { orderBy: { createdAt: "asc" } },
      },
    });
    const byItem = new Map<string, { name: string; quantity: number; unitPrice: number | null }>();
    for (const row of b.units) {
      const item = row.unit.item;
      const cur = byItem.get(item.id) ?? { name: item.name, quantity: 0, unitPrice: item.price === null ? null : Number(item.price) };
      cur.quantity += 1;
      byItem.set(item.id, cur);
    }
    // Crew-only items hold no unit: one line each, counted by how many
    // people-per-skill they created.
    const crewOnly = new Map<string, { name: string; gigs: number }>();
    for (const g of b.gigs) {
      if (!g.itemId || byItem.has(g.itemId)) continue;
      const cur = crewOnly.get(g.itemId) ?? { name: g.itemName, gigs: 0 };
      cur.gigs += 1;
      crewOnly.set(g.itemId, cur);
    }
    if (crewOnly.size > 0) {
      const items = await prisma.item.findMany({ where: { id: { in: [...crewOnly.keys()] } }, select: { id: true, price: true, skills: true } });
      for (const [id, v] of crewOnly) {
        const item = items.find((i) => i.id === id);
        byItem.set(id, { name: v.name, quantity: Math.max(1, Math.round(v.gigs / Math.max(1, item?.skills.length ?? 1))), unitPrice: item?.price == null ? null : Number(item.price) });
      }
    }
    return {
      customerName: b.customerName,
      phone: b.phone,
      email: b.email,
      eventDate: b.eventDate,
      eventTime: b.eventTime,
      address: b.address,
      total: b.total === null ? null : Number(b.total),
      balancePaymentPreference: b.balancePaymentPreference,
      lines: [...byItem.values()],
      addons: b.addons.map((a) => ({ itemName: a.itemName, groupName: a.groupName, addonName: a.addonName, priceDelta: Number(a.priceDelta), quantity: a.quantity })),
    };
  }
  const r = await prisma.designRequest.findUniqueOrThrow({ where: { id: agreement.designRequestId as string } });
  const cart = r.cart as {
    items?: { name: string; quantity: number; price: number | null }[];
    addons?: { itemName: string; groupName: string; addonName: string; priceDelta: number; quantity: number }[];
  };
  return {
    customerName: r.customerName,
    phone: r.phone,
    email: r.email,
    eventDate: r.eventDate,
    eventTime: r.eventTime,
    address: r.address,
    total: r.total === null ? null : Number(r.total),
    balancePaymentPreference: r.balancePaymentPreference,
    lines: (cart.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.price })),
    addons: cart.addons ?? [],
  };
}

// The contract as it reads right now, from the booking's real data and the
// live policy text. Called when the customer opens the link, and again
// when they sign, so what is signed is what is current.
export async function buildContractContent(agreementId: string): Promise<ContractContent> {
  const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId }, select: { id: true, accountId: true, bookingId: true, designRequestId: true } });
  const [subject, settings, policy] = await Promise.all([loadSubject(agreement), getSettings(agreement.accountId), currentPolicy(agreement.accountId)]);
  if (policy.text.trim() === "") {
    throw new ContractError(409, "no-policy", "The cancellation and deposit policy has not been written yet. Add it in Settings first.");
  }

  const dateText = subject.eventDate.toISOString().slice(0, 10);
  const total = subject.total;
  const depositAmount = total === null ? null : Math.round(total * settings.depositPercentage) / 100;
  const balanceAmount = total === null || depositAmount === null ? null : Math.round((total - depositAmount) * 100) / 100;

  const values: Record<string, string> = {
    customer_name: subject.customerName,
    event_date: longDate(dateText),
    event_time: subject.eventTime ?? "to be confirmed",
    event_address: subject.address ?? "to be confirmed",
    total: total === null ? "to be confirmed" : usd(total),
    // A bare number: the policy text writes the percent sign itself
    // ("{{depositPercentage}}% of your total").
    deposit_percentage: String(settings.depositPercentage),
    deposit_amount: depositAmount === null ? "to be confirmed" : usd(depositAmount),
    balance_amount: balanceAmount === null ? "to be confirmed" : usd(balanceAmount),
    cancellation_window_days: String(settings.cancellationWindowDays),
  };

  const serviceLines = subject.lines.map((l) => {
    const price = l.unitPrice === null ? "price to be confirmed" : `${usd(l.unitPrice)} each`;
    return `- ${l.name}${l.quantity > 1 ? ` x ${l.quantity}` : ""} (${price})`;
  });
  for (const a of subject.addons) {
    const delta = a.priceDelta === 0 ? "no charge" : `${a.priceDelta > 0 ? "+" : "-"}${usd(Math.abs(a.priceDelta))} each`;
    serviceLines.push(`  ${a.itemName}, ${a.groupName}: ${a.addonName} (${delta})`);
  }

  const sections = [
    {
      heading: "Parties",
      body: `This agreement is between The GO Event Group ("GO") and ${subject.customerName} ("Customer").`,
    },
    {
      heading: "Event",
      body: [`Date: ${values.event_date}`, `Time: ${values.event_time}`, `Place: ${values.event_address}`].join("\n"),
    },
    { heading: "Services", body: serviceLines.length > 0 ? serviceLines.join("\n") : "To be confirmed." },
    {
      heading: "Price and payment",
      body: [
        `Total: ${values.total}`,
        `Deposit (${values.deposit_percentage}%): ${values.deposit_amount}`,
        `Balance: ${values.balance_amount}`,
        `Balance payment: ${subject.balancePaymentPreference}`,
      ].join("\n"),
    },
    {
      heading: "Cancellation and deposit policy",
      body: mergeFields(policy.text, values),
    },
  ];
  const text = ["Event Services Agreement", ...sections.map((s) => `${s.heading}\n${s.body}`)].join("\n\n");

  return {
    agreementId,
    subject: { bookingId: agreement.bookingId, designRequestId: agreement.designRequestId },
    customerName: subject.customerName,
    customerPhone: subject.phone,
    customerEmail: subject.email,
    eventDate: dateText,
    eventTime: subject.eventTime,
    address: subject.address,
    lines: subject.lines,
    addons: subject.addons,
    total,
    depositPercentage: settings.depositPercentage,
    depositAmount,
    balanceAmount,
    balancePaymentPreference: subject.balancePaymentPreference,
    cancellationWindowDays: settings.cancellationWindowDays,
    policyVersion: { id: policy.id, version: policy.version },
    sections,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
}

// ---- PDF ---------------------------------------------------------------

// The standard PDF fonts only cover Latin-1. Common typographic
// characters are mapped to plain ones and anything else becomes "?" so a
// stray emoji can't stop a contract from being made.
function pdfSafe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/•/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) ? ch : "?";
    })
    .join("");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of pdfSafe(text).split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    const indent = /^\s+/.exec(paragraph)?.[0].length ?? 0;
    let line = " ".repeat(indent);
    for (const word of paragraph.trim().split(/\s+/)) {
      const trial = line.trim() === "" ? line + word : `${line} ${word}`;
      if (font.widthOfTextAtSize(trial, size) <= width) line = trial;
      else {
        out.push(line);
        line = " ".repeat(indent) + word;
      }
    }
    out.push(line);
  }
  return out;
}

export type ContractSignature = { name: string; signedAt: Date; ip: string | null };

const easternStamp = (d: Date) => d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "medium", timeZone: "America/New_York" });

// The contract as a real PDF. With a signature it carries the typed name
// on the signature line and an audit footer (signed electronically, when,
// and from which IP). Without one it is the unsigned copy staff can
// preview.
export type GoSigner = { name: string; title: string };

// GO's authorized representative, from Settings. Both parts are needed:
// with either empty there is no GO signer and no block is drawn.
export async function loadGoSigner(accountId: string): Promise<GoSigner | null> {
  const a = await prisma.account.findUnique({ where: { id: accountId }, select: { authorizedSignerName: true, authorizedSignerTitle: true } });
  const name = a?.authorizedSignerName?.trim();
  const title = a?.authorizedSignerTitle?.trim();
  return name && title ? { name, title } : null;
}

export async function buildContractPdf(content: ContractContent, signature?: ContractSignature, goSigner?: GoSigner | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Event Services Agreement, ${content.customerName}`);
  pdf.setAuthor("The GO Event Group");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const W = 612;
  const H = 792;
  const M = 54;
  const BOTTOM = 84;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.1);

  const ensure = (needed: number) => {
    if (y - needed < BOTTOM) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };
  const write = (text: string, font: PDFFont, size: number, lead = size + 4) => {
    for (const line of wrap(text, font, size, W - 2 * M)) {
      ensure(lead);
      page.drawText(line, { x: M, y: y - size, size, font, color: ink });
      y -= lead;
    }
  };

  write("Event Services Agreement", bold, 20, 28);
  write(`The GO Event Group  |  Agreement ${content.agreementId}`, regular, 9, 16);
  y -= 6;
  for (const section of content.sections) {
    ensure(60);
    write(section.heading, bold, 12, 18);
    write(section.body, regular, 10.5, 14.5);
    y -= 8;
  }

  ensure(140);
  y -= 6;
  write("Signature", bold, 12, 20);
  if (signature) {
    page.drawText(pdfSafe(signature.name), { x: M, y: y - 18, size: 20, font: script, color: rgb(0.05, 0.1, 0.4) });
    y -= 30;
    page.drawLine({ start: { x: M, y }, end: { x: M + 300, y }, thickness: 0.8, color: ink });
    y -= 14;
    write(`${signature.name}, ${content.customerName === signature.name ? "Customer" : `for ${content.customerName}`}`, regular, 9.5, 14);
    y -= 8;
    if (goSigner) {
      // GO's side, applied automatically once the customer has signed.
      ensure(110);
      y -= 10;
      write("GO's authorized representative", bold, 12, 20);
      page.drawText(pdfSafe(goSigner.name), { x: M, y: y - 18, size: 20, font: script, color: rgb(0.05, 0.1, 0.4) });
      y -= 30;
      page.drawLine({ start: { x: M, y }, end: { x: M + 300, y }, thickness: 0.8, color: ink });
      y -= 14;
      write(`${goSigner.name}, ${goSigner.title}, The GO Event Group`, regular, 9.5, 14);
      write(`Date: ${signature.signedAt.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "America/New_York" })}`, regular, 9.5, 14);
      y -= 8;
    }
    ensure(90);
    const audit = [
      `Signed electronically on ${easternStamp(signature.signedAt)} Eastern (${signature.signedAt.toISOString()} UTC)`,
      `from IP address ${signature.ip ?? "unknown"}.`,
      "The signer consented to sign this document electronically and agreed to its terms by typing their full name above.",
      ...(goSigner ? ["GO's authorized signature was applied automatically from GO's settings when the customer signed."] : []),
      `Content fingerprint: ${content.contentHash}`,
    ].join(" ");
    const boxLines = wrap(audit, regular, 8.5, W - 2 * M - 16);
    const boxH = boxLines.length * 11.5 + 18;
    ensure(boxH + 4);
    page.drawRectangle({ x: M, y: y - boxH, width: W - 2 * M, height: boxH, color: rgb(0.95, 0.95, 0.93), borderColor: rgb(0.7, 0.7, 0.68), borderWidth: 0.6 });
    boxLines.forEach((l, i) => page.drawText(l, { x: M + 8, y: y - 14 - i * 11.5, size: 8.5, font: regular, color: ink }));
    y -= boxH + 6;
  } else {
    page.drawLine({ start: { x: M, y: y - 26 }, end: { x: M + 300, y: y - 26 }, thickness: 0.8, color: ink });
    y -= 40;
    write("Unsigned copy. Not valid until the customer signs it.", regular, 9.5, 14);
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Agreement ${content.agreementId}   |   Page ${i + 1} of ${pages.length}`, { x: M, y: 40, size: 8, font: regular, color: rgb(0.4, 0.4, 0.4) });
  });
  return pdf.save();
}

// ---- links --------------------------------------------------------------

const token = () => randomBytes(32).toString("base64url");

// Where the customer opens the contract. The storefront renders it from
// the signing endpoints; STOREFRONT_URL says where that page lives. Without
// it the link points straight at the API's JSON, which works for testing
// and is not for customers.
export function signingLink(signingToken: string): string {
  const base = process.env.STOREFRONT_URL?.replace(/\/$/, "");
  if (base) return `${base}/sign/${signingToken}`;
  console.warn("[contracts] STOREFRONT_URL is not set; the signing link points at the API instead of a page");
  return `${apiBase()}/api/contracts/${signingToken}`;
}

export function apiBase(req?: { protocol: string; get(name: string): string | undefined }): string {
  const fromEnv = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "";
}

export const pdfLink = (downloadToken: string, req?: Parameters<typeof apiBase>[0]) => `${apiBase(req)}/api/contracts/pdf/${downloadToken}`;

// ---- issuing and signing -----------------------------------------------

// Makes the contract available to the customer: finds the agreement for a
// booking or design request (creating one for a booking that predates
// agreements), gives it an unguessable signing token, and marks the
// contract Sent. Idempotent: issuing again returns the same link.
export async function issueContract(target: { bookingId?: string | null; designRequestId?: string | null }): Promise<{
  agreementId: string;
  signingToken: string;
  link: string;
  signed: boolean;
}> {
  const account = await getDefaultAccount();
  const policy = await currentPolicy(account.id);
  if (policy.text.trim() === "") {
    throw new ContractError(409, "no-policy", "The cancellation and deposit policy has not been written yet. Add it in Settings first.");
  }
  let agreement = target.bookingId
    ? await prisma.agreement.findUnique({ where: { bookingId: target.bookingId } })
    : target.designRequestId
      ? await prisma.agreement.findUnique({ where: { designRequestId: target.designRequestId } })
      : null;
  if (!agreement) {
    if (target.bookingId) {
      const b = await prisma.booking.findFirst({ where: { id: target.bookingId, accountId: account.id }, select: { id: true, customerId: true } });
      if (!b) throw new ContractError(404, "not-found", "booking not found");
      agreement = await prisma.agreement.create({ data: { accountId: account.id, bookingId: b.id, customerId: b.customerId, policyVersionId: policy.id, checkboxChecked: false } });
    } else if (target.designRequestId) {
      const r = await prisma.designRequest.findFirst({ where: { id: target.designRequestId, accountId: account.id }, select: { id: true, customerId: true } });
      if (!r) throw new ContractError(404, "not-found", "design request not found");
      agreement = await prisma.agreement.create({ data: { accountId: account.id, designRequestId: r.id, customerId: r.customerId, policyVersionId: policy.id, checkboxChecked: false } });
    } else {
      throw new ContractError(400, "no-target", "bookingId or designRequestId is required");
    }
  }
  if (agreement.contractStatus === "Signed") {
    return { agreementId: agreement.id, signingToken: agreement.signingToken ?? "", link: agreement.contractUrl ?? "", signed: true };
  }
  const signingToken = agreement.signingToken ?? token();
  if (!agreement.signingToken || agreement.contractStatus !== "Sent" || agreement.contractProvider !== CONTRACT_PROVIDER) {
    await prisma.agreement.update({ where: { id: agreement.id }, data: { signingToken, contractProvider: CONTRACT_PROVIDER, contractStatus: "Sent", ...(agreement.contractSentAt ? {} : { contractSentAt: new Date() }) } });
  }
  return { agreementId: agreement.id, signingToken, link: signingLink(signingToken), signed: false };
}

export type SignInput = {
  fullName: string;
  consentToElectronicSignature: boolean;
  agreeToTerms: boolean;
  contentHash?: string;
  ip: string | null;
  userAgent: string | null;
  baseRequest?: Parameters<typeof apiBase>[0];
};

// Records the signature. Runs under a row lock on the agreement so two
// submissions can't both sign, builds the PDF from the contract as it
// reads now, stores it, and updates the Agreement's reserved fields. If
// the customer was shown different text (contentHash), it refuses so
// they never sign something they didn't read.
export async function signContract(signingToken: string, input: SignInput) {
  const agreement = await prisma.agreement.findUnique({ where: { signingToken } });
  if (!agreement) throw new ContractError(404, "not-found", "This signing link isn't valid.");

  const content = await buildContractContent(agreement.id);
  if (input.contentHash && input.contentHash !== content.contentHash) {
    throw new ContractError(409, "contract-changed", "The contract changed since you opened it. Please read it again before signing.");
  }
  const signedAt = new Date();
  const goSigner = await loadGoSigner(agreement.accountId);
  const pdf = await buildContractPdf(content, { name: input.fullName, signedAt, ip: input.ip }, goSigner);
  const downloadToken = token();
  const sha256 = createHash("sha256").update(pdf).digest("hex");

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ contract_status: string | null }[]>`SELECT contract_status FROM agreements WHERE id = ${agreement.id} FOR UPDATE`;
    if (locked[0]?.contract_status === "Signed") throw new ContractError(409, "already-signed", "This contract was already signed.");
    const doc = await tx.contractDocument.create({
      data: {
        accountId: agreement.accountId,
        agreementId: agreement.id,
        policyVersionId: content.policyVersion.id,
        downloadToken,
        text: content.text,
        pdf: Buffer.from(pdf),
        sha256,
        signedName: input.fullName,
        consentElectronic: true,
        agreedToTerms: true,
        signerIp: input.ip,
        signerUserAgent: input.userAgent?.slice(0, 300) ?? null,
        signedAt,
      },
    });
    const link = pdfLink(downloadToken, input.baseRequest);
    await tx.agreement.update({
      where: { id: agreement.id },
      data: { contractProvider: CONTRACT_PROVIDER, contractExternalId: doc.id, contractStatus: "Signed", contractUrl: link },
    });
    // A signed contract moves the booking to Signed (unless it has already
    // gone further or been cancelled). This is the system's move, not a
    // staff stage change, so it sends the signed confirmation, not the
    // stage text.
    let stageMoved = false;
    if (agreement.bookingId) {
      const moved = await tx.booking.updateMany({ where: { id: agreement.bookingId, status: { in: ["Held", "Contract Sent"] } }, data: { status: "Signed" } });
      stageMoved = moved.count > 0;
    }
    return { doc, link, stageMoved };
  });

  return { content, documentId: result.doc.id, pdfUrl: result.link, signedAt, sha256, stageMoved: result.stageMoved };
}
