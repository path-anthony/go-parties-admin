// Block A12. Writes the wording of every Settings page into
// docs/SETTINGS-PLAN.md, between the two copy markers, straight from
// src/settingsCopy.ts, so the list you review is the text on the screen.
// Run with: npm run settings:copy
import { readFileSync, writeFileSync } from "node:fs";

// Loaded at run time, so this script stays out of the server type check (the
// settings wording lives in src and is built for the browser).
type Field = { label: string; help: string };
type SectionSpec = { id: string; title: string; blurb: string; fields?: Field[]; panel?: string };
type PageSpec = { title: string; path: string; intro: string; sections: SectionSpec[] };
type Copy = Record<string, Record<string, string>>;
const mod = (await import(new URL("../src/settingsCopy.ts", import.meta.url).href)) as { PAGES: PageSpec[]; EDITOR_COPY: Copy & { templatesLink: { button: string; help: string } } };
const { PAGES, EDITOR_COPY } = mod;

const START = "<!-- copy:start -->";
const END = "<!-- copy:end -->";

const editorLines = (s: SectionSpec): [string, string][] => {
  const out: [string, string][] = [];
  const add = (label: string, text: string) => out.push([label, text]);
  switch (s.panel) {
    case "logo":
      add("Under the logo", EDITOR_COPY.logo.help);
      add("When your own logo is in use", EDITOR_COPY.logo.inUse);
      add("When the placeholder is in use", EDITOR_COPY.logo.placeholder);
      break;
    case "policy":
      add("Under the policy text", EDITOR_COPY.policy.help);
      break;
    case "terms":
      add("Top of the editor", EDITOR_COPY.terms.help);
      add("Header", EDITOR_COPY.terms.header);
      add("Pages 2 and 3", EDITOR_COPY.terms.pages);
      add("Clauses", EDITOR_COPY.terms.clauses);
      add("Notes and acceptance", EDITOR_COPY.terms.notes);
      break;
    case "services":
      add("Top of the table", EDITOR_COPY.services.help);
      add("Categories", EDITOR_COPY.services.categories);
      add("Name words", EDITOR_COPY.services.words);
      add("Specific items", EDITOR_COPY.services.items);
      break;
    case "leadColumns":
      add("Note about Booked and Lost", EDITOR_COPY.leadColumns.note);
      break;
    case "templatesLink":
      add(`Button: ${EDITOR_COPY.templatesLink.button}`, EDITOR_COPY.templatesLink.help);
      break;
    case "googleCalendar":
      add("Before connecting", EDITOR_COPY.google.connect);
      add("GO calendar", EDITOR_COPY.google.internal);
      add("Invites calendar", EDITOR_COPY.google.invites);
      add("Send calendar invites to customers", EDITOR_COPY.google.sendInvites);
      add("Add bookings when they are", EDITOR_COPY.google.stage);
      break;
    default:
  }
  if (s.id === "signer") {
    add("Under Name and Title, both filled in", EDITOR_COPY.signer.ok);
    add("Under Name and Title, only one filled in", EDITOR_COPY.signer.half);
  }
  return out;
};

const lines: string[] = [];
for (const page of PAGES) {
  lines.push(`### ${page.title} (\`${page.path}\`)`, "", `**Page line:** ${page.intro}`, "");
  for (const s of page.sections) {
    lines.push(`**${s.title}.** ${s.blurb}`, "");
    for (const f of s.fields ?? []) lines.push(`- **${f.label}.** ${f.help}`);
    for (const [label, text] of editorLines(s)) lines.push(`- *${label}.* ${text}`);
    if ((s.fields?.length ?? 0) + editorLines(s).length > 0) lines.push("");
  }
}
lines.push(
  "### Text that was already there and is unchanged",
  "",
  "- Home photos: \"These photos rotate at the top of your store's Home page. Use wide, bright photos of real events. 3 to 6 works best.\"",
  "- Integrations: the yes or no status lines, \"Still needed\" lines and \"Last ...\" lines inside each section.",
  "- Team: the invite form labels and the table. The invite link note now reads \"The link works once and expires after 72 hours.\"",
  "- Lead columns: the column list itself and its own error messages.",
  "",
);

const path = new URL("../docs/SETTINGS-PLAN.md", import.meta.url);
const doc = readFileSync(path, "utf8");
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < a) throw new Error("docs/SETTINGS-PLAN.md has no copy markers");
writeFileSync(path, `${doc.slice(0, a + START.length)}\n\n${lines.join("\n")}\n${doc.slice(b)}`);
console.log(`wrote the wording of ${PAGES.length} pages`);
