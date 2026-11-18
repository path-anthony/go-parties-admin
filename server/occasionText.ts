import { groupsOf } from "../src/lib/occasions.js";

// Block FIX1. The occasion a customer is planning, read from their own words,
// so a lead says what the customer actually wrote. Pure. It reads only the
// customer's messages, never the assistant's. A clear phrase wins; anything
// else is null and the caller keeps what it had.
//
// The store remembers one occasion for a whole visit (picked at an earlier
// checkout or from a package) and can send a stale one (docs/BUGS-AUDIT.md
// item 5). When the conversation names a different occasion, the
// conversation wins and both are kept on the lead so staff can see it.

const PATTERNS: [RegExp, string][] = [
  [/\b(bachelor(ette)?|stag|hen (do|party))\b/i, "Bachelor/Bachelorette"],
  [/\b(bar|bat|b'nai) ?mitzvah\b/i, "Bar/Bat Mitzvah"],
  [/\bsweet (16|sixteen)\b/i, "Sweet 16"],
  [/\bbaby ?shower\b/i, "Baby shower"],
  [/\bbridal ?shower\b/i, "Bridal shower"],
  [/\bgrad(uation|uating|s)?\b(?! student)/i, "Graduation"],
  [/\bretire(ment|ing)?\b/i, "Retirement"],
  [/\banniversary\b/i, "Anniversary"],
  [/\bhouse ?warming\b/i, "Housewarming"],
  [/\bengage(ment|d)\b/i, "Engagement party"],
  [/\brehearsal dinner\b/i, "Rehearsal dinner"],
  [/\breception\b/i, "Reception only"],
  [/\b(wedding|getting married)\b/i, "Ceremony + reception"],
  [/\b(holiday|christmas|xmas) (party|event)\b/i, "Holiday party"],
  [/\bteam[- ]?building\b/i, "Team building"],
  [/\bproduct launch\b/i, "Product launch"],
  [/\bclient appreciation\b/i, "Client appreciation"],
  [/\bgrand opening\b/i, "Grand opening"],
  [/\b(birthday|bday|b-day)\b|\bturn(s|ing) \d{1,2}\b|\b\d{1,2}(st|nd|rd|th) (party|birthday)\b/i, "Birthday"],
  [/\b(company|corporate|office|work) (picnic|party|event|outing)\b/i, "Corporate"],
];

export function occasionFromText(customerText: string): string | null {
  // The first one named in the customer's own order of words wins.
  let best: { at: number; occasion: string } | null = null;
  for (const [re, occasion] of PATTERNS) {
    const m = re.exec(customerText);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, occasion };
  }
  return best?.occasion ?? null;
}

// Whether what the store sent and what the customer wrote disagree. A group
// name agrees with any of its own occasions ("Kids party" and "Birthday");
// two different named occasions disagree.
export function occasionsConflict(fromStore: string | null, fromChat: string | null): boolean {
  if (!fromStore || !fromChat) return false;
  const a = fromStore.trim().toLowerCase();
  const b = fromChat.trim().toLowerCase();
  if (a === b || a === "other") return false;
  const storeGroups = groupsOf(fromStore);
  const chatGroups = groupsOf(fromChat);
  const storeIsGroup = storeGroups.length === 1 && storeGroups[0].toLowerCase() === a;
  const chatIsGroup = chatGroups.length === 1 && chatGroups[0].toLowerCase() === b;
  if (storeIsGroup) return !chatGroups.some((g) => g.toLowerCase() === a);
  if (chatIsGroup) return !storeGroups.some((g) => g.toLowerCase() === b);
  return true;
}

// The occasion to keep, and both values for the lead.
export function settleOccasion(fromStore: string | null, customerText: string): { occasion: string | null; fromStore: string | null; fromChat: string | null; conflict: boolean } {
  const fromChat = occasionFromText(customerText);
  const conflict = occasionsConflict(fromStore, fromChat);
  return { occasion: fromChat ?? fromStore ?? null, fromStore: fromStore ?? null, fromChat, conflict };
}
