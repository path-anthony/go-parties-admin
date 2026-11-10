import type { WeddingStatus, ShownRow, ShownSection } from "./logic.js";
import type { Template } from "./template.js";

// The staff print page: a plain HTML document laid out like the client's
// form, with only what is ticked or filled. Everything from the customer is
// escaped. The page carries no script; the admin's Print button opens it and
// calls the browser's print.

export type PrintView = { template: Template; bride: string; groom: string; eventDate: string; dueDate: string; status: WeddingStatus; sections: ShownSection[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const STATUS: Record<WeddingStatus, string> = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted" };
const pad = (n: number) => String(n).padStart(2, "0");

function rowsHtml(rows: ShownRow[]): string {
  const out: string[] = [];
  const plain = rows.filter((r) => r.group === null);
  if (plain.length) out.push(`<dl>${plain.map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value ?? "")}</dd></div>`).join("")}</dl>`);
  for (const group of [...new Set(rows.flatMap((r) => (r.group === null ? [] : [r.group])))]) {
    const ticked = rows.filter((r) => r.group === group);
    out.push(`<div class="group"><h3>${esc(group)}</h3><ul>${ticked.map((r) => `<li>${esc(r.label)}</li>`).join("")}</ul></div>`);
  }
  return out.join("");
}

export function renderWeddingPrint(v: PrintView): string {
  const couple = [v.bride, v.groom].filter((n) => n.trim() !== "").join(" & ") || "Couple's names not filled in yet";
  const sections = v.sections
    .map((s) => `<section><header><span class="num">${pad(s.number)}</span><div><h2>${esc(s.title)}</h2><p class="sub">${esc(s.subtitle)}${s.required ? "" : " (optional)"}</p></div></header>${s.rows.length ? rowsHtml(s.rows) : '<p class="empty">Nothing filled in.</p>'}</section>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(`Wedding details: ${couple}`)}</title>
<style>
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 Inter, -apple-system, "Segoe UI", Arial, sans-serif; color: #211d1c; background: #fff; }
  .band { background: #211d1c; color: #fff; padding: 20px 28px; display: flex; align-items: center; gap: 18px; border-bottom: 4px solid #f49b1f; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .band img { height: 58px; width: 58px; object-fit: contain; }
  .band .kicker { margin: 0; color: #f49b1f; font-weight: 800; font-size: 11px; letter-spacing: .06em; }
  .band h1 { margin: 2px 0 0; font-size: 21px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 28px; padding: 12px 28px; border-bottom: 1px solid #e8e2d9; }
  .meta b { color: #8c847c; font-size: 10.5px; letter-spacing: .05em; display: block; }
  main { padding: 6px 28px 24px; }
  section { padding: 14px 0 10px; border-bottom: 1px solid #e8e2d9; }
  section header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; break-after: avoid; }
  .num { color: #f49b1f; font-weight: 800; font-size: 24px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h2 { margin: 0; font-size: 15px; }
  .sub { margin: 0; color: #8c847c; font-size: 12px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px; }
  dl div { break-inside: avoid; }
  dt { color: #8c847c; font-size: 10.5px; letter-spacing: .03em; }
  dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .group { margin-top: 8px; break-inside: avoid; }
  h3 { margin: 0 0 3px; font-size: 11.5px; }
  ul { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 22px; }
  li { padding-left: 16px; position: relative; break-inside: avoid; }
  li::before { content: "\\2713"; position: absolute; left: 0; color: #d9820a; font-weight: 800; }
  .empty { margin: 0; color: #8c847c; }
</style></head>
<body>
  <div class="band"><img src="/api/contracts/logo.png" alt=""><div><p class="kicker">${esc(v.template.subtitle)}</p><h1>${esc(couple)}</h1></div></div>
  <div class="meta">
    <div><b>EVENT DATE</b>${esc(v.eventDate)}</div>
    <div><b>DETAILS DUE</b>${esc(v.dueDate)}</div>
    <div><b>STATUS</b>${STATUS[v.status]}</div>
  </div>
  <main>${sections}</main>
</body></html>`;
}
