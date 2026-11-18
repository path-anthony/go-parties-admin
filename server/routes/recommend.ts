import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { aiGate, companyPhone } from "../ai.js";
import { audienceOf, cleanSuggestions, starterPrompts } from "../askSuggestions.js";
import { applyCartAction, parseAskCart, wantsCartChange, type CartAction, type CartLine } from "../askCart.js";
import { settleOccasion } from "../occasionText.js";
import { PricingError, isPerGuestUnit, priceCart } from "../pricing.js";
import { todayEastern } from "../validate.js";
import { botCheck } from "../botCheck.js";
import { contactLine, leadContactFrom, type LeadContact } from "../leadContact.js";
import { getDefaultStatus } from "../leadStatuses.js";
import { notifyNewLead } from "../notifications.js";
import { safeErr } from "../log.js";
import { safeInline, stripControlKeepNewlines } from "../sanitize.js";
import { canonicalOccasion } from "../../src/lib/occasions.js";
import { PUBLIC_ITEM_RELATIONS, toPublicItem } from "../publicItem.js";
import type { Item } from "../../src/generated/prisma/client.js";

const router = Router();

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
// A real message is "1-3 sentences"; anything shorter than this is almost
// certainly a degenerate output (observed: the model occasionally returns
// the literal string "placeholder" instead of real reasoning). Retry rather
// than show that to the user.
const MIN_MESSAGE_LENGTH = 20;
const MAX_ATTEMPTS = 3;
// The prompt asks for at most this many; the cap is enforced here too so
// a generous no-budget pick can't turn into an unmanageable list.
const MAX_RECOMMENDED_ITEMS = 20;
// A conversation is a short back and forth. These bound what one request can
// cost: the model reads every message on every turn.
export const MAX_MESSAGES = 10;
export const MAX_MESSAGE_CHARS = 500;

type ConversationMessage = { role: "user" | "assistant"; content: string };
type LeadItem = { id: string; name: string; category: string; price: number | null; priceUnit: string | null };

// Fire-and-forget: logs a Lead only once a turn commits to a real
// recommendation, never on a clarifying-question turn, and (Block F2) only
// when there is somebody to reach: a name, an email or a phone. A chat with
// none of the three makes no lead. Never awaited on the response path, and
// errors are swallowed (logged, not thrown): a slow or failed insert must not
// add latency or block the customer's answer.
function logLead(accountId: string, who: LeadContact | null, theme: string, items: LeadItem[], total: number, suggestConcierge = false, occ: { occasion: string | null; fromStore: string | null; fromChat: string | null } = { occasion: null, fromStore: null, fromChat: null }) {
  if (!who) return;
  getDefaultStatus(accountId)
    .then((status) =>
      prisma.lead.create({
        // Block FIX1: the occasion the customer wrote about, with what the
        // store sent kept beside it.
        data: { accountId, source: "ask-go", status, customerName: who.name, contact: contactLine(who), theme, occasion: occ.occasion, occasionFromStore: occ.fromStore, occasionFromChat: occ.fromChat, itemsReturned: { items, total, suggestConcierge } },
      }),
    )
    .then((lead) => notifyNewLead(lead))
    .catch((err: unknown) => {
      console.error("[lead] failed to log lead:", safeErr(err));
    });
}

function toLeadItems(items: Item[]): LeadItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price !== null ? Number(item.price) : null,
    priceUnit: item.priceUnit,
  }));
}

function isValidMessage(entry: unknown): entry is ConversationMessage {
  if (typeof entry !== "object" || entry === null) return false;
  const { role, content } = entry as { role?: unknown; content?: unknown };
  const roleValid = role === "user" || role === "assistant";
  const contentValid = typeof content === "string" && content.trim() !== "";
  return roleValid && contentValid;
}

export type ParsedMessages = { ok: true; messages: ConversationMessage[] } | { ok: false; error: string; reason: "bad-messages" | "too-many-messages" };

// Shape and size checks. A message longer than the cap is clipped to it, not
// refused: the storefront sends the whole conversation back on every turn,
// so refusing one long message would break the conversation for good. The
// count is a hard stop. Control characters are replaced so they cannot be
// used to smuggle structure into the prompt.
export function parseMessages(value: unknown): ParsedMessages {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isValidMessage)) {
    return { ok: false, reason: "bad-messages", error: "messages is required and must be a non-empty array of {role, content}" };
  }
  // The customer speaks first and last. A request that ends on an "assistant"
  // turn is not a question; answering it would spend budget on a reply to
  // words the caller put in the assistant's mouth.
  if (value[0].role !== "user" || value[value.length - 1].role !== "user") {
    return { ok: false, reason: "bad-messages", error: "the conversation must start and end with a user message" };
  }
  if (value.length > MAX_MESSAGES) {
    return { ok: false, reason: "too-many-messages", error: `A conversation can have at most ${MAX_MESSAGES} messages.` };
  }
  return { ok: true, messages: value.map((m) => ({ role: m.role, content: stripControlKeepNewlines(m.content).slice(0, MAX_MESSAGE_CHARS) })) };
}

type CatalogRow = { id: string; name: string; category: string; price: unknown; priceUnit: string | null; description?: string | null };

// What the model may see about an item: id, name, category, price and unit,
// and the customer-facing description (Block A7, public by definition).
// Nothing internal. In particular not Item.notes, which hold supplier names,
// costs and staff remarks; whatever is in the prompt can come back out in a
// reply, so the prompt only ever holds what is already public.
export function catalogLine(item: CatalogRow): string {
  return `- id: ${item.id}, name: ${item.name}, category: ${item.category}, price: $${item.price}${item.priceUnit ? ` (${item.priceUnit})` : ""}${item.description ? `, about: ${item.description}` : ""}`;
}

const INSTRUCTIONS =
    "You are Ask GO, a knowledgeable crew member at The Go Event Group, not a chatbot. You help a customer build " +
  "a real party from a real catalog over a short back-and-forth conversation.\n\n" +
  "The bar for ready is exactly three signals: occasion type, a rough guest count, and a budget signal. The " +
  "moment all three are present in the conversation, go ready immediately and recommend, even on the first " +
  "message. Budget has three distinct states, keep them apart:\n" +
  "1. Never addressed: nobody has mentioned money yet. This is a missing signal, exactly like a missing " +
  "occasion or guest count. Once you have occasion and guest count, ask about budget with one short casual " +
  "question. Do not skip this and do not assume 'no budget' from silence.\n" +
  "2. Explicitly declined: the customer says something like 'no budget', 'money's not an issue', 'whatever " +
  "it costs', 'don't worry about price'. Only then stop asking about it, treat it as 'show me what's " +
  "possible', and lean toward the highest-value items in the catalog across categories, not a safe modest " +
  "set. Never ask about budget again after a decline.\n" +
  "3. A real number or range: build within or close to it.\n" +
  "Do not ask about logistics, venue, colors, preferences, or anything beyond those three signals; those " +
  "are details you can reasonably assume or the customer can adjust later, not a reason to hold back a " +
  "recommendation. Ask at most one clarifying question per turn, for exactly one missing signal, never a " +
  "list of questions. Recommend at most 20 items.\n\n" +
  "Concierge: GO also offers a planning call with a real person. When you are ready and the party is a wedding, " +
  "has a large guest count (roughly 100 or more), or comes to a total well above a typical booking (several " +
  "thousand dollars), set suggest_concierge true alongside your normal recommendation. It's a nudge for the " +
  "storefront to offer the call, not a reason to hold back items or to mention it in your message.\n\n" +
  "Voice: short, sure, chill. 1-3 sentences. No exclamation points, no emoji, no 'Great question', no hype " +
  "words ('unforgettable', 'elevate', 'seamless', 'magical'). Matter-of-fact, then a little warmth. No em " +
  "dashes, use a period or comma instead.\n\n" +
  "Suggested replies: with every reply, also write 2 to 4 short lines the customer could tap to send next, " +
  "in the suggestions field. They are the customer's words, not yours. If your message asks a question, " +
  "they are plausible answers to that exact question and nothing else: for a budget question, two or three " +
  "dollar ranges that fit the party described so far (its occasion and guest count) plus 'Not sure yet'; for " +
  "a date question, 'This month', 'Next month', 'Not sure yet'; for a guest count question, ranges like " +
  "'Under 25' or '50 to 75'; for an occasion question, kinds of party. If your message recommends items, " +
  "they are sensible next moves for this kind of party and this lineup: add a category that fits and is " +
  "not in it yet, bring the total down, change the size, or 'Looks good, book it'. Every line must fit the " +
  "occasion and the people in this conversation. Never mention kids, children or parents for an adult party " +
  "(a bachelor or bachelorette party, a 30th, a retirement, a wedding, a company event), and never suggest " +
  "anything adult only for a kids party. Each line is 6 words or fewer, with no punctuation at the end, no " +
  "emoji and no quotation marks. Never repeat a line the customer has already sent. The suggestions never " +
  "change which items you pick or what you say.\n\n" +
  "The cart: the customer may already have a cart, shown after the catalog as 'The customer's cart right now'; " +
  "when it is not shown, the cart is empty. " +
  "Never change it unless the customer asks for a change. A question about delivery, setup, space, power, " +
  "water, weather or rain, timing, payment, prices or policies is answered in two or three plain sentences " +
  "and the cart stays exactly as it is: cart_action none. Only when the customer asks to add, remove, swap, " +
  "lower the total, change the size, or start over do you change it: add (item_ids are the items to add), " +
  "remove (item_ids are the items to take out), or replace (item_ids are the whole new cart). Building the " +
  "first lineup when there is no cart is replace. If you don't know an answer, say so and offer a person: " +
  "call or text GO. Never invent a fee, a size or a rule.\n\n" +
  "Prices: an item marked (per guest) costs its price times the guest count, so 100 guests of a $10 per " +
  "guest item is $1,000. Check the budget with that math, and always put the guest count you are using in " +
  "guest_count. Everything else costs its price once per unit.\n\n" +
  "You may only recommend items by the exact id given in the catalog below. Never invent an item, id, or price. " +
  "Pick a set of items that fits the occasion, guest count, and budget as closely as possible, favoring a mix " +
  "of categories over many items from one category. If the budget can't be met with real items, get as close " +
  "as you can and say so.\n";

// The static part (instructions, then the catalog) comes first and carries the
// cache marker, so every turn of every conversation reuses it at a fraction of
// the price. Only the short sub-occasion line, which changes, comes after.
export function buildSystem(catalogItems: CatalogRow[], subOcc: string | null, cart: { lines: CartLine[]; total: number | null; guestCount: number | null } | null = null): Anthropic.TextBlockParam[] {
  const catalog = catalogItems.map(catalogLine).join("\n");
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: INSTRUCTIONS },
    { type: "text", text: `Catalog:\n${catalog}`, cache_control: { type: "ephemeral" } },
  ];
  if (subOcc) blocks.push({ type: "text", text: `The customer selected sub-occasion: ${subOcc}. If their own messages describe a different occasion, follow their messages.` });
  // Block FIX1: what the customer has now. Names and prices come from the
  // catalog here, never from the store, so nothing typed reaches this part.
  if (cart && cart.lines.length > 0) {
    const lines = cart.lines.map((l) => `- id: ${l.id}, ${l.name}${l.perGuest ? " (per guest)" : l.quantity > 1 ? ` x ${l.quantity}` : ""}`).join("\n");
    blocks.push({ type: "text", text: `The customer's cart right now (${cart.lines.length} items${cart.total !== null ? `, $${cart.total}` : ""}${cart.guestCount ? ` for ${cart.guestCount} guests` : ""}):\n${lines}` });
  }
  return blocks;
}

export const RESPOND_TOOL: Anthropic.Tool = {
  name: "respond_to_party_request",
  description:
    "Decide whether you have enough to recommend real items with confidence, or whether one clarifying question " +
    "would meaningfully improve the pick.",
  input_schema: {
    type: "object",
    properties: {
      ready: {
        type: "boolean",
        description:
          "True once you have three signals: the occasion type, a rough guest count, and a budget signal. A " +
          "budget signal is either a real number or an explicit decline ('no budget', 'money's not an issue', " +
          "'whatever it costs'). If budget has simply never come up in the conversation, that is a missing " +
          "signal, so ready is false and you ask about it. False whenever any of the three is missing.",
      },
      message: {
        type: "string",
        description:
          "If ready is false: one short, casual clarifying question, 1-3 sentences, asking for exactly one " +
          "missing signal (occasion, guest count, or budget, in that order). If ready is true: a short " +
          "closing line, 1-3 sentences, on why these items fit.",
      },
      suggest_concierge: {
        type: "boolean",
        description:
          "True when this party would be better served by a planning call with a real person than by a cart: " +
          "a wedding, a large guest count (roughly 100 or more), or a total well above a typical booking " +
          "(several thousand dollars). It is a nudge, not a gate: still give the full recommendation. False " +
          "for an ordinary party and whenever ready is false.",
      },
      item_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Only used when cart_action is add, remove or replace: the items that action applies to (see " +
          "cart_action), taken only from the catalog provided, at most 20. With a real budget, build within or close to it. When the customer explicitly declined to give " +
          "one, lean toward the highest-value items across categories, this is 'show me what's possible', not " +
          "a safe middle. Leave empty when ready is false.",
      },
      cart_action: {
        type: "string",
        enum: ["none", "add", "remove", "replace"],
        description:
          "What this reply does to the customer's cart. none: the cart stays exactly as it is (every question, " +
          "every reply that only asks something, and any turn where the customer did not ask for a change). add: " +
          "item_ids are added. remove: item_ids are taken out. replace: item_ids are the whole new cart (the " +
          "first lineup, or when the customer asks to start over or rebuild it).",
      },
      guest_count: {
        type: "integer",
        description: "The guest count from the conversation, when the customer has given one. Per-guest items are priced on it.",
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
        description:
          "2 to 4 short replies the customer could tap to send next, in their own words, 6 words or fewer each, " +
          "no punctuation at the end, no emoji. When ready is false: plausible answers to the one question in " +
          "message (for budget: dollar ranges that fit this party, plus 'Not sure yet'). When ready is true: " +
          "next moves that fit this party and this lineup, such as adding a fitting category, lowering the " +
          "total, changing the size, or 'Looks good, book it'. They must fit the occasion and audience of this " +
          "conversation: nothing about kids or parents for an adult party, nothing adult only for a kids party.",
      },
    },
    required: ["ready", "message", "item_ids", "suggest_concierge", "suggestions", "cart_action"],
  },
};

// The one model call. Tests replace it with setAskGoModel and never call
// Anthropic.
export type AskGoModel = (request: Anthropic.MessageCreateParamsNonStreaming) => Promise<Pick<Anthropic.Message, "content" | "stop_reason">>;
let modelOverride: AskGoModel | null = null;
export function setAskGoModel(f: AskGoModel | null) {
  modelOverride = f;
}

// Block G1. Before the customer has typed anything there is no conversation
// to read, so no model call is made: these are opening lines, one for each
// kind of party, that rotate by day. ?occasion= puts that kind first.
router.get("/starters", (req, res) => {
  const occasion = typeof req.query.occasion === "string" ? safeInline(req.query.occasion, 40) : "";
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ suggestions: starterPrompts(todayEastern(), occasion || null) });
});

// Mounted in index.ts behind markAdmin and the per-IP limiter. The bot check
// runs here. Ask GO's timestamp is when the conversation started, so on the
// first message it is "now" by design: the too-fast rule applies from the
// second message on.
router.post("/", botCheck("recommend", { minAgeApplies: (req) => Array.isArray(req.body?.messages) && req.body.messages.length > 1 }), async (req, res) => {
  const { subOcc: rawSubOcc, messages: rawMessages } = req.body ?? {};
  const parsed = parseMessages(rawMessages);
  if (!parsed.ok && parsed.reason === "too-many-messages") {
    // A friendly end to a long conversation, in the shape the storefront
    // already shows as a reply. Nothing is spent.
    const phone = await companyPhone();
    return res.json({ ready: false, suggestConcierge: false, suggestions: [], limit: "conversation", message: `That's as far as I can take this one here. Call or text us${phone ? ` at ${phone}` : ""} and we'll finish it with you.` });
  }
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error, reason: parsed.reason });
  }
  const messages = parsed.messages;
  if (rawSubOcc !== null && rawSubOcc !== undefined && typeof rawSubOcc !== "string") {
    return res.status(400).json({ error: "subOcc must be a string or null" });
  }
  // A known occasion in its known spelling, or short clean text: customer
  // text never reaches the instructions part of the prompt unchecked.
  const subOcc = typeof rawSubOcc === "string" && rawSubOcc.trim() !== "" ? (canonicalOccasion(rawSubOcc) ?? safeInline(rawSubOcc, 40)) || null : null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !modelOverride) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  }
  // Budget: every AI request counts, whichever feature makes it.
  // Over the daily cap the answer is a normal reply, so every storefront
  // build shows the sentence instead of a generic error.
  const budget = await aiGate(req, res);
  if (!budget.ok) return res.json({ ready: false, suggestConcierge: false, suggestions: [], limit: "daily-cap", message: budget.message });

  const account = await getDefaultAccount();
  // Block F2: who is asking, when the request or a signed-in account says.
  const who = await leadContactFrom(req, (req.body ?? {}) as Record<string, unknown>);
  // theme is derived from every user turn so far, joined. It is used only for the
  // Lead row (logged just once, on the turn that commits to ready:true).
  const theme = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .join(" / ");

  // Only items with a real price can be totaled honestly. TBD/custom-quote
  // items are excluded from what the model is even shown.
  const catalogItems = await prisma.item.findMany({
    // Block A8: hidden items are never shown to the model or the customer.
    where: { accountId: account.id, price: { not: null }, hidden: false },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: PUBLIC_ITEM_RELATIONS,
  });

  if (catalogItems.length === 0) {
    logLead(account.id, who, theme, [], 0);
    return res.json({ ready: true, message: "No priced items in the catalog yet.", items: [], total: 0, suggestConcierge: false, suggestions: [] });
  }

  const anthropic = modelOverride ? null : new Anthropic({ apiKey: apiKey as string });
  const callModel: AskGoModel = modelOverride ?? ((request) => (anthropic as Anthropic).messages.create(request));
  // Block FIX1: the cart the store has now, read against the catalog (ids
  // only; names and prices are the catalog's), and the guest count it sent.
  const catalogById = new Map(catalogItems.map((item: Item) => [item.id, item]));
  const current = parseAskCart((req.body ?? {}).cart, catalogById);
  const storeGuests = typeof (req.body ?? {}).guestCount === "number" && Number.isInteger((req.body ?? {}).guestCount) && (req.body ?? {}).guestCount >= 1 && (req.body ?? {}).guestCount <= 5000 ? ((req.body ?? {}).guestCount as number) : null;
  // Block FIX1: the occasion is what the customer wrote; the store's pick is
  // only passed on when it agrees with that.
  const customerText = messages.filter((m) => m.role === "user").map((m) => m.content).join(" / ");
  const occ = settleOccasion(subOcc, customerText);
  const cartTotal = (lines: CartLine[], guests: number | null) => totalOf(lines, guests);
  const system = buildSystem(catalogItems, occ.conflict ? null : subOcc, { lines: current, total: cartTotal(current, storeGuests).total, guestCount: storeGuests });
  // Block G1: who the party is for, from the customer's own words and the
  // occasion they picked, for the backstop check on the suggestions.
  const audience = audienceOf(`${occ.conflict ? "" : (subOcc ?? "")} ${theme}`);
  const lastUser = messages[messages.length - 1].content;

  let message = "";
  let requestedIds: string[] = [];
  let suggestConcierge = false;
  let action: CartAction = "none";
  let modelGuests: number | null = null;
  // Block G1: the tap-to-send replies, from the same call as the message.
  let suggestions: string[] = [];
  let next: CartLine[] = current;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await callModel({
      model: MODEL,
      // Room for a 1-3 sentence line, 20 catalog ids (the ids are long) and
      // up to four short suggested replies.
      max_tokens: 2304,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [RESPOND_TOOL],
      tool_choice: { type: "tool", name: "respond_to_party_request" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      console.warn(`[recommend] attempt ${attempt}: model returned no tool_use block`);
      continue;
    }

    const input = toolUse.input as { ready?: unknown; message?: unknown; item_ids?: unknown; suggest_concierge?: unknown; suggestions?: unknown; cart_action?: unknown; guest_count?: unknown };
    const ready = input.ready === true;
    suggestConcierge = input.suggest_concierge === true;
    message = typeof input.message === "string" ? input.message : "";
    // Missing or malformed suggestions are an empty list, never a reason to
    // retry and never replaced with fixed text.
    suggestions = cleanSuggestions(input.suggestions, audience);
    requestedIds = Array.isArray(input.item_ids)
      ? input.item_ids.filter((id): id is string => typeof id === "string").slice(0, MAX_RECOMMENDED_ITEMS)
      : [];
    modelGuests = typeof input.guest_count === "number" && Number.isInteger(input.guest_count) && input.guest_count >= 1 && input.guest_count <= 5000 ? input.guest_count : null;
    // An older model answer with no cart_action: a ready lineup is a replace.
    const said = input.cart_action;
    action = said === "add" || said === "remove" || said === "replace" || said === "none" ? said : ready && requestedIds.length > 0 ? "replace" : "none";
    // The rule the client asked for, kept here as well as in the prompt: a
    // question never changes a cart the customer already has.
    if (action !== "none" && current.length > 0 && !wantsCartChange(lastUser)) {
      console.warn(`[recommend] attempt ${attempt}: the model changed the cart on a question; kept the cart`);
      action = "none";
    }
    next = applyCartAction(current, action, requestedIds, catalogById);

    // A change that leaves nothing to show (an add or a lineup with no real
    // items) is as useless as an empty message: retried.
    const emptyChange = (action === "add" || action === "replace") && next.length === 0;
    if (message.trim().length >= MIN_MESSAGE_LENGTH && !emptyChange) break;
    console.warn(
      `[recommend] attempt ${attempt}: degenerate response (action=${action}, ids=${requestedIds.length}, stop=${response.stop_reason}, message length ${message.length}), retrying`,
    );
  }

  if (message.trim().length < MIN_MESSAGE_LENGTH || ((action === "add" || action === "replace") && next.length === 0)) {
    return res.status(502).json({ error: "Model did not return a usable response" });
  }

  const guestCount = modelGuests ?? storeGuests;
  // What stays the same in every reply: the occasion read from the chat and
  // the guest count, so the store can show them and send them back.
  const common = { suggestConcierge, suggestions, cartAction: action, guestCount, occasion: occ.occasion };

  if (action === "none") {
    // The cart is untouched. ready stays false so a store that only knows
    // "ready means a new lineup" keeps the cart it has.
    return res.json({ ready: false, message, ...common, suggestConcierge: current.length > 0 ? suggestConcierge : false });
  }

  const droppedIds = requestedIds.filter((id) => !catalogById.has(id));
  if (droppedIds.length > 0) {
    console.warn(`[recommend] dropped ${droppedIds.length} id(s) not in the catalog`);
  }
  // Block FIX1: the cart's total by the one pricing rule.
  const { total, guestCountNeeded } = cartTotal(next, guestCount);
  const recommended = next.map((l) => catalogById.get(l.id)).filter((item): item is (typeof catalogItems)[number] => item !== undefined);
  logLead(account.id, who, theme, toLeadItems(recommended), total ?? 0, suggestConcierge, occ);

  // What goes back to the customer is the same allowlist the public catalog
  // uses, nothing internal. items is the whole cart after the change (so a
  // store that replaces its cart on every lineup still ends up right);
  // added and removed say what changed.
  const items = next.map((l) => ({ ...toPublicItem(catalogById.get(l.id) as (typeof catalogItems)[number]), quantity: l.quantity }));
  const before = new Set(current.map((l) => l.id));
  const after = new Set(next.map((l) => l.id));
  res.json({
    ready: true,
    message,
    items,
    total,
    ...common,
    added: next.filter((l) => !before.has(l.id)).map((l) => l.id),
    removed: current.filter((l) => !after.has(l.id)).map((l) => l.id),
    ...(guestCountNeeded ? { guestCountNeeded: true } : {}),
  });
});

// The cart's total by the one pricing rule. A per-guest item with no guest
// count yet is left out of the total, and guestCountNeeded says so.
function totalOf(lines: CartLine[], guests: number | null): { total: number | null; guestCountNeeded: boolean } {
  const items = lines.map((l) => ({ id: l.id, name: l.name, price: l.price, priceUnit: l.priceUnit }));
  const quantities = Object.fromEntries(lines.map((l) => [l.id, l.quantity]));
  try {
    return { total: priceCart({ items, quantities, guestCount: guests }).total, guestCountNeeded: false };
  } catch (err) {
    if (!(err instanceof PricingError)) throw err;
    const rest = items.filter((i) => !isPerGuestUnit(i.priceUnit));
    return { total: rest.length === 0 ? null : priceCart({ items: rest, quantities }).total, guestCountNeeded: true };
  }
}

export default router;
