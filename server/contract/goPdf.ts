import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { CLAUSES_ON_PAGE_2, GO_LABELS, type Cents, type GoDocument, type GoField } from "./goDocument.js";

// The GO contract as a PDF: a near replica of the paper form, three pages.
// Page 1 is the client, the event, the services and the payment summary;
// pages 2 and 3 the terms, the acceptance block and the signatures. Colors
// and labels are the paper's (and the storefront page's). Text is set in
// Liberation Sans (metric-compatible with the Helvetica the reference
// embeds; SIL OFL, vendored in server/assets) and typed signatures in a
// handwriting face (Great Vibes, OFL). Both are embedded and subset, so the
// PDF looks the same in every viewer. Only what is in the document is drawn;
// a null is an empty box, like the blank form.

const SIGNATURE_FONT = readFileSync(new URL("../assets/GreatVibes-Regular.ttf", import.meta.url));
const TEXT_FONT = readFileSync(new URL("../assets/LiberationSans-Regular.ttf", import.meta.url));
const TEXT_FONT_BOLD = readFileSync(new URL("../assets/LiberationSans-Bold.ttf", import.meta.url));

const W = 612;
const H = 792;
const M = 36;
const INNER = W - 2 * M;
const FOOT_Y = 44;

const INK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const ORANGE = rgb(254 / 255, 160 / 255, 2 / 255);
const LABEL = rgb(0.27, 0.27, 0.27);
const BOX = rgb(1, 248 / 255, 234 / 255);
const BOX_AUTO = rgb(230 / 255, 230 / 255, 230 / 255);
const RULE = rgb(0.47, 0.47, 0.47);
const LIGHT_RULE = rgb(0.84, 0.84, 0.84);
const LINK = rgb(26 / 255, 79 / 255, 180 / 255);
const NAVY = rgb(13 / 255, 26 / 255, 102 / 255);
const GREY = rgb(0.67, 0.67, 0.67);

export type GoPdfInput = {
  doc: GoDocument;
  logo: { bytes: Uint8Array; type: string } | null;
  // Present on a signed contract: the audit line at the end.
  audit?: { signedAt: Date; ip: string | null; contentHash: string } | null;
};

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
      return code === 10 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) ? ch : "?";
    })
    .join("");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of pdfSafe(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || line === "") line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = t.slice(0, -1);
  return t === pdfSafe(text) ? t : `${t.slice(0, -1)}…`.replace("…", "...");
}

export const money = (v: Cents): string => (v === null ? "" : v === "-" ? "-" : `${v < 0 ? "-" : ""}$${(Math.abs(v) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const percent = (n: number | null): string => (n === null ? "" : `${n}%`);
const signedOn = (iso: string | null): string => {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
};

type Fonts = { regular: PDFFont; bold: PDFFont; script: PDFFont };

class Painter {
  page: PDFPage;
  y = H - M;
  readonly pdf: PDFDocument;
  readonly fonts: Fonts;
  readonly logo: PDFImage | null;
  readonly doc: GoDocument;
  readonly pageNo: number;
  readonly pageCount: number;
  constructor(pdf: PDFDocument, fonts: Fonts, logo: PDFImage | null, doc: GoDocument, pageNo: number, pageCount: number) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.logo = logo;
    this.doc = doc;
    this.pageNo = pageNo;
    this.pageCount = pageCount;
    this.page = pdf.addPage([W, H]);
  }

  text(t: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
    this.page.drawText(pdfSafe(t), { x, y, size, font, color });
  }
  textRight(t: string, right: number, y: number, font: PDFFont, size: number, color = INK) {
    const s = pdfSafe(t);
    this.page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color });
  }
  textCenter(t: string, y: number, font: PDFFont, size: number, color = INK) {
    const s = pdfSafe(t);
    this.page.drawText(s, { x: (W - font.widthOfTextAtSize(s, size)) / 2, y, size, font, color });
  }
  rect(x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>) {
    this.page.drawRectangle({ x, y, width: w, height: h, color });
  }
  rule(x1: number, x2: number, y: number, color = RULE, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  // A black bar with an orange heading; the form's section divider.
  sectionBar(title: string, sub?: string | null) {
    this.y -= 7;
    const h = 14;
    this.rect(M, this.y - h, INNER, h, INK);
    this.text(title, M + 6, this.y - h + 4.5, this.fonts.bold, 8.5, ORANGE);
    if (sub) this.text(sub, M + 6 + this.fonts.bold.widthOfTextAtSize(title, 8.5) + 8, this.y - h + 4.5, this.fonts.bold, 7, ORANGE);
    this.y -= h;
  }

  // A row of labelled value boxes, widths as fractions of the inner width.
  fieldRow(cells: { label: string; value: string | null; auto?: boolean; strong?: boolean; hint?: string | null }[], weights: number[]) {
    const gap = 6;
    const total = weights.reduce((a, b) => a + b, 0);
    const usable = INNER - gap * (cells.length - 1);
    const labelH = 8;
    const boxH = 13;
    this.y -= 3;
    let x = M;
    const top = this.y;
    let extra = 0;
    cells.forEach((c, i) => {
      const w = (usable * weights[i]) / total;
      this.text(c.label, x, top - labelH + 1.5, this.fonts.bold, 6.2, LABEL);
      const boxTop = top - labelH - 2;
      this.rect(x, boxTop - boxH, w, boxH, c.auto ? BOX_AUTO : BOX);
      this.rule(x, x + w, boxTop - boxH, RULE);
      if (c.value) this.text(fit(c.value, c.strong ? this.fonts.bold : this.fonts.regular, 8.5, w - 6), x + 3, boxTop - boxH + 4.5, c.strong ? this.fonts.bold : this.fonts.regular, 8.5);
      if (c.hint) {
        this.text(c.hint, x, boxTop - boxH - 8, this.fonts.regular, 6, LABEL);
        extra = 8;
      }
      x += w + gap;
    });
    this.y = top - labelH - 2 - boxH - extra;
  }

  note(text: string, size = 6.6, color = LABEL) {
    this.y -= 4;
    for (const line of wrap(text, this.fonts.regular, size, INNER)) {
      this.text(line, M, this.y - size, this.fonts.regular, size, color);
      this.y -= size + 2.4;
    }
  }

  footer() {
    this.rule(M, W - M, FOOT_Y + 10, ORANGE, 1.6);
    if (this.doc.company.footerLine) this.text(fit(this.doc.company.footerLine, this.fonts.regular, 6.5, INNER - 60), M, FOOT_Y, this.fonts.regular, 6.5, LABEL);
    this.textRight(GO_LABELS.pageOf(this.pageNo, this.pageCount), W - M, FOOT_Y, this.fonts.regular, 6.5, LABEL);
  }

  drawLogo(x: number, y: number, size: number) {
    if (!this.logo) return;
    this.page.drawImage(this.logo, { x, y, width: size, height: size });
  }
}

// ---- page 1 --------------------------------------------------------------------------

function page1(pdf: PDFDocument, fonts: Fonts, logo: PDFImage | null, doc: GoDocument) {
  const p = new Painter(pdf, fonts, logo, doc, 1, 3);
  const { header, company, client, event, services, payment } = doc;

  // Banner.
  const bannerH = 86;
  p.rect(0, H - bannerH, W, bannerH, INK);
  p.drawLogo(W - M - 60, H - 12 - 60, 60);
  let y = H - 22;
  if (header.title) p.text(header.title, M, y - 8, fonts.bold, 16.5, ORANGE);
  y -= 21;
  if (header.confirmByLine) p.text(fit(header.confirmByLine, fonts.bold, 7.2, INNER - 90), M, y - 4, fonts.bold, 7.2, ORANGE);
  y -= 10;
  p.rect(M, y - 15, 290, 15, WHITE);
  if (header.confirmByDate) p.text(header.confirmByDate, M + 5, y - 11, fonts.bold, 9);
  y -= 27;
  if (header.nonRefundableLine) p.text(header.nonRefundableLine, M, y - 2, fonts.bold, 10, ORANGE);
  p.y = H - bannerH - 13;

  // Company line.
  if (company.name) p.text(company.name, M, p.y, fonts.bold, 11);
  if (company.website) p.textRight(company.website, W - M, p.y, fonts.regular, 8.5, LINK);
  p.y -= 11;
  const companyLine = [company.addressLine, company.phone ? `Phone: ${company.phone}` : null, company.email].filter(Boolean).join("   |   ");
  if (companyLine) p.text(fit(companyLine, fonts.regular, 7.5, INNER), M, p.y, fonts.regular, 7.5, LABEL);
  p.y -= 4;

  p.sectionBar(GO_LABELS.sections.client);
  p.fieldRow([{ label: GO_LABELS.client[0], value: client.nameOrg }, { label: GO_LABELS.client[1], value: client.email }], [3, 2]);
  p.fieldRow([{ label: GO_LABELS.client[2], value: client.mailingAddress }, { label: GO_LABELS.client[3], value: client.city }, { label: GO_LABELS.client[4], value: client.state }, { label: GO_LABELS.client[5], value: client.zip }], [4, 2, 1, 1.4]);
  p.fieldRow([{ label: GO_LABELS.client[6], value: client.phoneHome }, { label: GO_LABELS.client[7], value: client.phoneWork }, { label: GO_LABELS.client[8], value: client.phoneCell }], [1, 1, 1]);

  p.sectionBar(GO_LABELS.sections.event);
  const E = GO_LABELS.event;
  p.fieldRow([{ label: E[0], value: event.type }, { label: E[1], value: event.guestOfHonor }, { label: E[2], value: event.date }], [1, 1, 1]);
  p.fieldRow([{ label: E[3], value: event.timeFromTo }, { label: E[4], value: event.expectedGuests }, { label: E[5], value: event.ageRange }], [1, 1, 1]);
  p.fieldRow([{ label: E[6], value: event.venueName }, { label: E[7], value: event.venueAddress }, { label: E[8], value: event.venuePhone }], [1, 1.6, 0.9]);
  p.fieldRow([{ label: E[9], value: event.onsiteContactName }, { label: E[10], value: event.onsiteContactPhone }, { label: E[11], value: event.planner }], [1, 0.9, 1.6]);

  p.sectionBar(GO_LABELS.sections.special);
  p.y -= 5;
  const specialH = 30;
  p.rect(M, p.y - specialH, INNER, specialH, BOX);
  p.page.drawRectangle({ x: M, y: p.y - specialH, width: INNER, height: specialH, borderColor: RULE, borderWidth: 0.6 });
  if (doc.specialRequests) {
    let yy = p.y - 10;
    for (const line of wrap(doc.specialRequests, fonts.regular, 8, INNER - 10).slice(0, 3)) {
      p.text(line, M + 5, yy, fonts.regular, 8);
      yy -= 10;
    }
  }
  p.y -= specialH;

  p.sectionBar(GO_LABELS.sections.services, GO_LABELS.sections.servicesSub);
  p.y -= 4;
  const colW = (INNER - 14) / 2;
  const colTop = p.y;
  let lowest = p.y;
  [services.left, services.right].forEach((rows, i) => {
    const x0 = M + i * (colW + 14);
    let yy = colTop;
    p.text(GO_LABELS.serviceColumns[0], x0 + colW - 148, yy - 6, fonts.bold, 6, LABEL);
    p.text(GO_LABELS.serviceColumns[1], x0 + colW - 42, yy - 6, fonts.bold, 6, LABEL);
    yy -= 9;
    for (const r of rows) {
      yy = serviceRow(p, r, x0, yy, colW);
    }
    lowest = Math.min(lowest, yy);
  });
  p.y = lowest;
  if (services.note) p.note(services.note);

  p.sectionBar(GO_LABELS.sections.payment);
  const P = GO_LABELS.payment;
  p.fieldRow(
    [
      { label: P[0], value: money(payment.subtotal), auto: true },
      { label: P[1], value: percent(payment.discountPercent) },
      { label: P[2], value: money(payment.discountAmount) },
      { label: P[3], value: money(payment.totalDiscount), auto: true },
      { label: P[4], value: payment.discountDescription },
    ],
    [1.2, 0.9, 1.1, 1.3, 1.6],
  );
  p.fieldRow(
    [
      { label: P[5], value: money(payment.total), auto: true, strong: true },
      { label: GO_LABELS.retainerLabel(payment.retainerPercent), value: money(payment.retainerAmount), auto: true, strong: true },
      { label: GO_LABELS.balanceLabel(payment.balanceDueDays), value: money(payment.balance), auto: true, strong: true, hint: payment.balanceDueDate ? `Due ${payment.balanceDueDate}` : null },
    ],
    [1, 1, 1],
  );
  if (payment.note) p.note(payment.note, 6.8, INK);
  p.footer();
}

function serviceRow(p: Painter, r: GoField, x0: number, y: number, colW: number): number {
  const detailsW = 100;
  const feeW = 48;
  if (r.isGroupHeading) {
    const h = 11;
    p.rect(x0, y - h, colW, h, BOX_AUTO);
    if (r.label) p.text(r.label, x0 + 3, y - h + 3, p.fonts.bold, 6.5);
    return y - h - 2;
  }
  const h = 12;
  // Checkbox.
  p.page.drawRectangle({ x: x0 + 1, y: y - h + 3, width: 7, height: 7, borderColor: INK, borderWidth: 0.7, color: WHITE });
  if (r.checked) {
    p.page.drawLine({ start: { x: x0 + 2.3, y: y - h + 6.5 }, end: { x: x0 + 4.2, y: y - h + 4.3 }, thickness: 1.1, color: INK });
    p.page.drawLine({ start: { x: x0 + 4.2, y: y - h + 4.3 }, end: { x: x0 + 7.3, y: y - h + 9 }, thickness: 1.1, color: INK });
  }
  if (r.label) p.text(fit(r.label, p.fonts.bold, 7.5, colW - detailsW - feeW - 16), x0 + 11, y - h + 3.5, p.fonts.bold, 7.5);
  const dx = x0 + colW - detailsW - feeW - 4;
  p.rect(dx, y - h + 1, detailsW, h - 2, BOX);
  p.rule(dx, dx + detailsW, y - h + 1, RULE);
  if (r.details) p.text(fit(r.details, p.fonts.regular, 7, detailsW - 4), dx + 2, y - h + 4, p.fonts.regular, 7);
  const fx = x0 + colW - feeW;
  p.rect(fx, y - h + 1, feeW, h - 2, BOX);
  p.rule(fx, fx + feeW, y - h + 1, RULE);
  const fee = money(r.fee);
  if (fee) p.textRight(fee, fx + feeW - 2, y - h + 4, p.fonts.regular, 7);
  p.rule(x0, x0 + colW, y - h, LIGHT_RULE, 0.4);
  return y - h - 1;
}

// ---- pages 2 and 3 -------------------------------------------------------------------

function termsHeader(p: Painter) {
  const h = 40;
  p.rect(0, H - h, W, h, INK);
  p.drawLogo(W - M - 30, H - 5 - 30, 30);
  if (p.doc.terms.pageHeader) p.text(fit(p.doc.terms.pageHeader, p.fonts.bold, 10.5, INNER - 50), M, H - 17, p.fonts.bold, 10.5, ORANGE);
  if (p.doc.terms.pageSubheader) p.text(fit(p.doc.terms.pageSubheader, p.fonts.regular, 7.2, INNER - 50), M, H - 30, p.fonts.regular, 7.2, ORANGE);
  p.y = H - h - 6;
}

function clause(p: Painter, c: GoDocument["terms"]["clauses"][number], size = 8.2, lead = 10.4): boolean {
  const head = `${c.number !== null ? `${c.number}. ` : ""}${c.title ?? ""}${c.title ? "." : ""}`;
  const headW = head ? p.fonts.bold.widthOfTextAtSize(pdfSafe(head), size) + 3 : 0;
  // First line wraps around the bold heading; the rest at full width.
  const body = c.body ?? "";
  const words = pdfSafe(body).split(/\s+/).filter(Boolean);
  const lines: { text: string; first: boolean }[] = [];
  let line = "";
  let first = true;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    const width = INNER - (first ? headW : 0);
    if (p.fonts.regular.widthOfTextAtSize(next, size) <= width || line === "") line = next;
    else {
      lines.push({ text: line, first });
      first = false;
      line = word;
    }
  }
  lines.push({ text: line, first });
  const needed = lines.length * lead + 3;
  if (p.y - needed < FOOT_Y + 18) return false;
  for (const l of lines) {
    if (l.first && head) p.text(head, M, p.y - size, p.fonts.bold, size);
    p.text(l.text, M + (l.first ? headW : 0), p.y - size, p.fonts.regular, size);
    p.y -= lead;
  }
  p.y -= 3;
  return true;
}

function signatureRow(p: Painter, who: string, auto: boolean, sig: GoDocument["signatures"]["client"], placeholderX: boolean) {
  const cols = GO_LABELS.signatureCols(who, auto);
  const gap = 8;
  const weights = [1.3, 1.5, 0.7];
  const total = weights.reduce((a, b) => a + b, 0);
  const usable = INNER - gap * 2;
  p.y -= 8;
  p.rule(M, W - M, p.y, LIGHT_RULE, 0.5);
  p.y -= 10;
  let x = M;
  const labelY = p.y;
  const boxH = 24;
  cols.forEach((label, i) => {
    const w = (usable * weights[i]) / total;
    p.text(label, x, labelY, p.fonts.bold, 6.2, LABEL);
    const top = labelY - 4;
    p.rect(x, top - boxH, w, boxH, BOX);
    p.rule(x, x + w, top - boxH, RULE);
    const name = sig?.printedName ?? "";
    if (i === 0 && name) p.text(fit(name, p.fonts.regular, 9, w - 6), x + 3, top - boxH + 8, p.fonts.regular, 9);
    if (i === 1) {
      p.page.drawRectangle({ x, y: top - boxH, width: w, height: boxH, borderColor: RULE, borderWidth: 0.6 });
      if (name) p.text(fit(name, p.fonts.script, 17, w - 10), x + 5, top - boxH + 7, p.fonts.script, 17, NAVY);
      else if (placeholderX) p.text("X", x + 5, top - boxH + 8, p.fonts.bold, 11, GREY);
    }
    if (i === 2) {
      const d = signedOn(sig?.signedAt ?? null);
      if (d) p.text(d, x + 3, top - boxH + 8, p.fonts.regular, 9);
    }
    x += w + gap;
  });
  p.y = labelY - 4 - boxH;
}

function pages2and3(pdf: PDFDocument, fonts: Fonts, logo: PDFImage | null, doc: GoDocument, audit: GoPdfInput["audit"]) {
  let p = new Painter(pdf, fonts, logo, doc, 2, 3);
  termsHeader(p);
  p.sectionBar(doc.terms.heading ?? "TERMS AND CONDITIONS");
  p.y -= 8;
  const clauses = doc.terms.clauses;
  let i = 0;
  // Page 2 carries the reference's first thirteen clauses, or as many as fit.
  for (; i < clauses.length && i < CLAUSES_ON_PAGE_2; i++) {
    if (!clause(p, clauses[i])) break;
  }
  p.footer();
  p = new Painter(pdf, fonts, logo, doc, 3, 3);
  termsHeader(p);
  p.y -= 4;
  for (; i < clauses.length; i++) {
    if (!clause(p, clauses[i], 7.8, 9.8)) break; // the template's last three fit; a longer set is tightened
  }
  p.sectionBar(doc.acceptance.heading ?? "ACCEPTANCE AND SIGNATURES");
  p.y -= 6;
  if (doc.acceptance.text) {
    for (const line of wrap(doc.acceptance.text, fonts.regular, 7.6, INNER)) {
      p.text(line, M, p.y - 7.6, fonts.regular, 7.6);
      p.y -= 9.6;
    }
  }
  p.y -= 4;
  // The one checkbox, ticked on a signed contract.
  const signed = doc.signatures.client !== null;
  p.page.drawRectangle({ x: M + 2, y: p.y - 8, width: 7.5, height: 7.5, borderColor: INK, borderWidth: 0.7, color: WHITE });
  if (signed) {
    p.page.drawLine({ start: { x: M + 3.5, y: p.y - 4.2 }, end: { x: M + 5.4, y: p.y - 6.6 }, thickness: 1.1, color: INK });
    p.page.drawLine({ start: { x: M + 5.4, y: p.y - 6.6 }, end: { x: M + 8.8, y: p.y - 1.5 }, thickness: 1.1, color: INK });
  }
  if (doc.acceptance.esignLabel) p.text(doc.acceptance.esignLabel, M + 14, p.y - 7, fonts.regular, 7.6);
  p.y -= 12;
  const S = GO_LABELS.signers;
  signatureRow(p, S[0].who, S[0].auto, doc.signatures.client, false);
  signatureRow(p, S[1].who, S[1].auto, doc.signatures.additional, false);
  signatureRow(p, S[2].who, S[2].auto, doc.signatures.go, !doc.signatures.go?.printedName);
  p.y -= 14;
  if (doc.acceptance.confirmLine) p.textCenter(doc.acceptance.confirmLine, p.y, fonts.bold, 7.6);
  p.y -= 10;
  if (doc.acceptance.nonRefundableLine) p.textCenter(doc.acceptance.nonRefundableLine, p.y, fonts.regular, 7.6);
  p.y -= 14;
  if (audit && doc.signatures.client) {
    const stamp = audit.signedAt.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "America/New_York" });
    const line = [
      `Signed electronically by ${doc.signatures.client.printedName ?? ""}${doc.signatures.additional?.printedName ? ` and ${doc.signatures.additional.printedName}` : ""} on ${stamp} Eastern (${audit.signedAt.toISOString()} UTC) from IP address ${audit.ip ?? "unknown"}.`,
      "By typing their name the signer consented to sign and receive this contract electronically and agreed to its terms.",
      doc.signatures.go?.printedName ? "GO Event Group's signature was applied from its settings when the contract was sent." : "",
      `Content fingerprint: ${audit.contentHash}`,
    ]
      .filter(Boolean)
      .join(" ");
    const lines = wrap(line, fonts.regular, 6.5, INNER - 12);
    const boxH = lines.length * 8 + 8;
    if (p.y - boxH > FOOT_Y + 14) {
      p.page.drawRectangle({ x: M, y: p.y - boxH, width: INNER, height: boxH, borderColor: LIGHT_RULE, borderWidth: 0.5 });
      let yy = p.y - 10;
      for (const l of lines) {
        p.text(l, M + 6, yy, fonts.regular, 6.5, LABEL);
        yy -= 8;
      }
    }
  }
  p.footer();
}

export async function buildGoPdf(input: GoPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${input.doc.company.name ?? "Contract"}, ${input.doc.client.nameOrg ?? ""}`.trim());
  pdf.setAuthor(input.doc.company.name ?? "");
  const fonts: Fonts = {
    regular: await pdf.embedFont(TEXT_FONT, { subset: true }),
    bold: await pdf.embedFont(TEXT_FONT_BOLD, { subset: true }),
    script: await pdf.embedFont(SIGNATURE_FONT, { subset: true }),
  };
  let logo: PDFImage | null = null;
  if (input.logo) {
    try {
      logo = input.logo.type === "image/png" ? await pdf.embedPng(input.logo.bytes) : await pdf.embedJpg(input.logo.bytes);
    } catch {
      logo = null;
    }
  }
  page1(pdf, fonts, logo, input.doc);
  pages2and3(pdf, fonts, logo, input.doc, input.audit ?? null);
  return pdf.save();
}
