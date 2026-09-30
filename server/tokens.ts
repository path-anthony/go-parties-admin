// The merge-token resolver. There is one, used for the policy text inside
// a contract and for every automated message. A token is {{name}} in
// camelCase or snake_case (the two spellings are the same token). The
// caller supplies the values; what a token means and what it may be used
// in is decided by whoever builds the values (contracts.ts for policy
// text, messageContext.ts for messages).

export const camelToSnake = (key: string) => key.replace(/([A-Z])/g, "_$1").toLowerCase();

const TOKEN = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

// The tokens a piece of text uses, in the spelling typed, once each.
export function referencedTokens(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];
}

// Policy text: known tokens are filled in; anything else is left exactly
// as typed, so a typo shows up in the contract instead of vanishing.
export function mergeFields(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (whole, raw: string) => {
    const key = camelToSnake(raw);
    return key in values ? values[key] : whole;
  });
}

export type Rendered = {
  text: string;
  // Tokens that resolved to nothing (no value, or an empty one).
  empty: string[];
  // Tokens this message is not allowed to use at all (typos, or a token
  // from another kind of message).
  notAllowed: string[];
};

// A message: same tokens, stricter rule. Every token used must be one the
// trigger allows, and must have a real value; otherwise the message is
// not sent (the pipeline logs it as blocked). The text is still returned
// with the bad tokens left in place, for the log and the preview.
export function renderMessage(text: string, values: Record<string, string>, allowed: string[]): Rendered {
  const allowedSnake = new Set(allowed.map(camelToSnake));
  const empty: string[] = [];
  const notAllowed: string[] = [];
  const out = text.replace(TOKEN, (whole, raw: string) => {
    const key = camelToSnake(raw);
    if (!allowedSnake.has(key)) {
      if (!notAllowed.includes(raw)) notAllowed.push(raw);
      return whole;
    }
    const value = values[key];
    if (value === undefined || value.trim() === "") {
      if (!empty.includes(raw)) empty.push(raw);
      return whole;
    }
    return value;
  });
  return { text: out, empty, notAllowed };
}

// Every token a message can use, for the chips in the editor and the
// sample preview. "unavailable" ones exist in the registry's vocabulary
// but nothing in the app can fill them yet.
export type TokenInfo = { key: string; label: string; example: string; unavailable?: string };

export const TOKEN_CATALOG: TokenInfo[] = [
  { key: "customerFirstName", label: "Customer first name", example: "Sarah" },
  { key: "customerName", label: "Customer full name", example: "Sarah Miller" },
  { key: "eventDate", label: "Event date", example: "Sat, Oct 10" },
  { key: "eventTime", label: "Event time", example: "2 PM" },
  { key: "eventType", label: "Type of event", example: "Sweet 16" },
  { key: "eventAddress", label: "Event address", example: "12 Main St, Farmington" },
  { key: "daysUntilEvent", label: "Days until the event", example: "7" },
  { key: "balanceDue", label: "Balance due", example: "$800.00" },
  { key: "depositAmount", label: "Deposit amount", example: "$200.00" },
  { key: "contractLink", label: "Contract signing link", example: "https://example.com/sign/abc" },
  { key: "contractPdfLink", label: "Signed contract PDF link", example: "https://example.com/contract.pdf" },
  { key: "portalLink", label: "Customer portal link", example: "https://example.com/party" },
  { key: "cartLink", label: "Saved cart link", example: "https://example.com/cart/abc", unavailable: "The storefront doesn't save carts on the server yet." },
  { key: "holdExpiresAt", label: "When the hold ends", example: "Fri 5 PM", unavailable: "Holds don't expire in the app yet." },
  { key: "companyName", label: "Company name", example: "GO! Event Group" },
  { key: "companyPhone", label: "Company phone", example: "(860) 555-0100" },
  { key: "depositPercentage", label: "Deposit percentage (number)", example: "20" },
  { key: "cancellationWindowDays", label: "Cancellation window (days)", example: "5" },
  { key: "crewFirstName", label: "Crew first name", example: "Alex" },
  { key: "gigRole", label: "Gig role", example: "DJ/MC" },
  { key: "gigItemName", label: "What the gig is for", example: "MC and DJ: Basic (4 hrs)" },
  { key: "gigDate", label: "Gig date", example: "Sat, Oct 10" },
  { key: "gigStartTime", label: "Gig start time", example: "2 PM" },
  { key: "gigTown", label: "Gig town", example: "Farmington", unavailable: "Bookings hold one address line, not a separate town." },
  { key: "gigAddress", label: "Gig address", example: "12 Main St, Farmington" },
  { key: "gigLink", label: "Crew gig page link", example: "https://example.com/gig/abc", unavailable: "The crew gig page arrives with bidding in Block 3." },
  { key: "bidLink", label: "Bid link", example: "https://example.com/bid/abc", unavailable: "Bidding arrives in Block 3." },
  { key: "bidRange", label: "Bid range", example: "$150 to $250", unavailable: "Bidding arrives in Block 3." },
  { key: "bidAmount", label: "Bid amount", example: "$200.00", unavailable: "Bidding arrives in Block 3." },
  { key: "bidDeadline", label: "Bid deadline", example: "Fri 5 PM", unavailable: "Bidding arrives in Block 3." },
];
