// Text a customer typed ends up inside texts and emails we send in our own
// name. Names and free text are cleaned before they go in: control and
// invisible characters removed, links removed (a "name" that is a phishing
// link must not reach someone's phone from our number), length capped.

// C0 and C1 controls, zero width and bidi characters, line and paragraph
// separators, and the byte order mark.
const INVISIBLE = "\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF";
const CONTROL = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${INVISIBLE}]`, "g");
const CONTROL_KEEP_NEWLINE = new RegExp(`[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F${INVISIBLE}]`, "g");
const SCHEME_URL = /\b(?:https?|ftp):\/\/\S+/gi;
const WWW_URL = /\bwww\.\S+/gi;
const BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|us|app|ly|me|xyz|info|biz|gl|link|top|site|online|shop|click|cc|tk|ru|cn)\b(?:\/\S*)?/gi;

// Control and invisible characters out, nothing else touched (an email address
// or phone number must come through unchanged).
export function stripControl(value: string | null | undefined, max = 200): string {
  if (!value) return "";
  const cleaned = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trimEnd();
}

// Same, but line breaks stay (a chat message).
export function stripControlKeepNewlines(value: string): string {
  return value.replace(CONTROL_KEEP_NEWLINE, " ");
}

export function stripUrls(text: string): string {
  return text.replace(SCHEME_URL, " ").replace(WWW_URL, " ").replace(BARE_DOMAIN, " ");
}

// One line of customer-supplied text, safe to put in a message.
export function safeInline(value: string | null | undefined, max = 120): string {
  if (!value) return "";
  const cleaned = stripUrls(value.replace(CONTROL, " ")).replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trimEnd();
}

// Multi-line free text (notes): control characters other than newlines go,
// links go, and the length is capped.
export function safeText(value: string | null | undefined, max = 1000): string {
  if (!value) return "";
  const cleaned = stripUrls(value.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NEWLINE, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trimEnd();
}
