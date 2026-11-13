import { stripControl } from "./sanitize.js";

// Block G1. Ask GO's suggested replies: the short tap-to-send lines the
// storefront shows under the chat. The model writes them in the same call
// that writes the reply (see RESPOND_TOOL in routes/recommend.ts); this file
// only checks what came back. Pure, no database, no model.
//
// The rule that matters: nothing here ever invents a suggestion for a reply.
// When the model's list is missing, malformed, or does not survive the
// checks, the answer is an empty list and the storefront shows no buttons.

export const MIN_SUGGESTIONS = 2;
export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_WORDS = 6;
const MAX_SUGGESTION_CHARS = 48;

// Pictographs, dingbats, arrows and flags, then what is left of a joined
// emoji: variation selectors, joiners and keycap marks.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const EMOJI_GLUE = /\uFE0F|\u200D|\u20E3/g;

// En and em dashes, written as escapes so this file holds neither.
const DASHES = new RegExp("[\\u2013\\u2014]", "g");

function cleanOne(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // One line of plain text: no control characters, no markup, no emoji, no
  // em or en dashes, no quotes around it, nothing at the end but a letter,
  // a digit, a closing bracket or a plus sign ("$1,500+").
  const text = stripControl(value, 200)
    .replace(EMOJI, "")
    .replace(EMOJI_GLUE, "")
    .replace(DASHES, " to ")
    .replace(/[<>`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[.!?,;:\s]+$/g, "")
    .trim();
  if (text === "" || text.length > MAX_SUGGESTION_CHARS) return null;
  if (text.split(" ").length > MAX_SUGGESTION_WORDS) return null;
  if (/https?:|www\.|@/i.test(text)) return null;
  return text;
}

export type Audience = "adult" | "kids" | "unknown";

const ADULT = /\b(bachelor|bachelorette|stag|hen (do|party)|retirement|anniversary|wedding|reception|rehearsal dinner|bridal|engagement|housewarming|adults? only|2[1-9](st|nd|rd|th)|[3-9]\d(st|nd|rd|th)|100th)\b/i;
const KIDS = /\b(kids?|children|child|toddlers?|baby shower|first birthday|([1-9]|1[0-7])[ -]?(years?|yrs?)[ -]?old|turn(s|ing) ([1-9]|1[0-7])\b|(1st|2nd|3rd|[4-9]th|1[0-7]th) (birthday|bday)|sweet 16|sweet sixteen|bar mitzvah|bat mitzvah|elementary|kindergarten|preschool)\b/i;

// Who the party is for, from what the customer has said (and the occasion
// they picked on the store, if any). Only a clear reading counts: a
// conversation with both kinds of signal, or neither, is "unknown" and
// nothing is filtered. A company event is left unknown on purpose: a company
// picnic often has families at it, so the model's own reading stands.
export function audienceOf(customerText: string): Audience {
  const adult = ADULT.test(customerText);
  const kids = KIDS.test(customerText);
  if (adult && !kids) return "adult";
  if (kids && !adult) return "kids";
  return "unknown";
}

// A backstop for the prompt's own rule. An adult party never gets a line
// about kids or parents; a kids party never gets a line that only fits adults.
const KIDS_WORDS = /\b(kids?|kiddos?|children|child|parents?|toddlers?|little ones?|family friendly)\b/i;
const ADULT_ONLY_WORDS = /\b(cigars?|shots?|kegs?|beer pong|bachelor|bachelorette|open bar|cocktails?|21\+)\b/i;

export function fitsAudience(suggestion: string, audience: Audience): boolean {
  if (audience === "adult") return !KIDS_WORDS.test(suggestion);
  if (audience === "kids") return !ADULT_ONLY_WORDS.test(suggestion);
  return true;
}

// What the model sent, checked. Returns 2 to 4 clean lines or nothing.
export function cleanSuggestions(value: unknown, audience: Audience = "unknown"): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanOne(entry);
    if (!text || !fitsAudience(text, audience)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out.length >= MIN_SUGGESTIONS ? out : [];
}

// ---- before the customer has typed anything --------------------------------------
//
// There is no conversation yet, so there is nothing for the model to read and
// no call is made. These are opening lines the customer can tap to start, one
// from each kind of party GO does, so the first screen never reads as a kids
// party only. They rotate by day so a returning customer sees different ones.
// Each names an occasion and a guest count, which are two of the three things
// Ask GO needs, so the first reply can go straight to the budget.

const STARTERS: Record<"kids" | "adult" | "wedding" | "corporate", string[]> = {
  kids: ["Backyard birthday for 20 kids", "Graduation party for 50", "Sweet 16 for 60 guests", "Baby shower for 30"],
  adult: ["40th birthday for 40 guests", "Bachelorette party for 15", "Retirement party for 50", "Backyard anniversary for 60"],
  wedding: ["Wedding reception for 120", "Rehearsal dinner for 40", "Engagement party for 50", "Bridal shower for 30"],
  corporate: ["Company picnic for 100", "Office holiday party for 80", "Client appreciation for 60", "Team building day for 40"],
};
const ORDER = ["kids", "adult", "corporate", "wedding"] as const;
const GROUP_OF: Record<string, (typeof ORDER)[number]> = { "kids party": "kids", "adult party": "adult", wedding: "wedding", corporate: "corporate" };

// Four starters, one per kind of party. When the customer already picked a
// kind on the store, that kind leads.
export function starterPrompts(day: string, group: string | null = null): string[] {
  const n = Math.abs([...day].reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7));
  const lead = group ? (GROUP_OF[group.trim().toLowerCase()] ?? null) : null;
  const order = lead ? [lead, ...ORDER.filter((k) => k !== lead)] : [...ORDER];
  return order.map((kind, i) => STARTERS[kind][(n + i) % STARTERS[kind].length]);
}
