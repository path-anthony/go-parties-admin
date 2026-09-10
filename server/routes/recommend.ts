import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import type { Item } from "../../src/generated/prisma/client.js";

const router = Router();

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
// A real message is "1-3 sentences"; anything shorter than this is almost
// certainly a degenerate output (observed: the model occasionally returns
// the literal string "placeholder" instead of real reasoning). Retry rather
// than show that to the user.
const MIN_MESSAGE_LENGTH = 20;
const MAX_ATTEMPTS = 3;

type ConversationMessage = { role: "user" | "assistant"; content: string };
type LeadItem = { id: string; name: string; category: string; price: number | null; priceUnit: string | null };

// Fire-and-forget: logs a Lead only once a turn commits to a real
// recommendation, never on a clarifying-question turn — an abandoned or
// still-in-progress conversation must never show up in Bookings. Never
// awaited on the response path, and errors are swallowed (logged, not
// thrown): a slow or failed insert must not add latency or block the
// customer's answer.
function logLead(accountId: string, theme: string, items: LeadItem[], total: number) {
  prisma.lead
    .create({ data: { accountId, theme, itemsReturned: { items, total } } })
    .catch((err: unknown) => {
      console.error("[lead] failed to log lead:", err);
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

function parseMessages(value: unknown): ConversationMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isValidMessage) ? value : null;
}

const RESPOND_TOOL: Anthropic.Tool = {
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
          "True the moment you have occasion type, a rough guest count, and a budget signal, nothing else is " +
          "required. False only when one of those three is genuinely missing.",
      },
      message: {
        type: "string",
        description:
          "If ready is false: one short, casual clarifying question, 1-3 sentences, asking for exactly one " +
          "missing thing. If ready is true: a short closing line, 1-3 sentences, on why these items fit.",
      },
      item_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Only used when ready is true: IDs of recommended items, taken only from the catalog provided. Leave " +
          "empty when ready is false.",
      },
    },
    required: ["ready", "message", "item_ids"],
  },
};

router.post("/", async (req, res) => {
  const { subOcc, messages: rawMessages } = req.body ?? {};
  const messages = parseMessages(rawMessages);
  if (!messages) {
    return res.status(400).json({ error: "messages is required and must be a non-empty array of {role, content}" });
  }
  if (subOcc !== null && subOcc !== undefined && typeof subOcc !== "string") {
    return res.status(400).json({ error: "subOcc must be a string or null" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  }

  const account = await getDefaultAccount();
  // theme is derived from every user turn so far, joined — used only for the
  // Lead row (logged just once, on the turn that commits to ready:true).
  const theme = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .join(" / ");

  // Only items with a real price can be totaled honestly. TBD/custom-quote
  // items are excluded from what the model is even shown.
  const catalogItems = await prisma.item.findMany({
    where: { accountId: account.id, price: { not: null } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  if (catalogItems.length === 0) {
    logLead(account.id, theme, [], 0);
    return res.json({ ready: true, message: "No priced items in the catalog yet.", items: [], total: 0 });
  }

  const catalogText = catalogItems
    .map((item: Item) => {
      const parts = [
        `id: ${item.id}`,
        `name: ${item.name}`,
        `category: ${item.category}`,
        `price: $${item.price}${item.priceUnit ? ` (${item.priceUnit})` : ""}`,
      ];
      if (item.notes) parts.push(`notes: ${item.notes}`);
      return `- ${parts.join(", ")}`;
    })
    .join("\n");

  const anthropic = new Anthropic({ apiKey });

  const system =
    "You are Ask GO, a knowledgeable crew member at The Go Event Group, not a chatbot. You help a customer build " +
    "a real party from a real catalog over a short back-and-forth conversation.\n\n" +
    "The bar for ready is exactly three things: occasion type, a rough guest count, and a budget signal. The " +
    "moment all three are present in the conversation, go ready immediately and recommend, even on the first " +
    "message. Do not ask about logistics, venue, colors, preferences, or anything else once you have those " +
    "three, that's a detail you can reasonably assume or the customer can adjust later, not a reason to hold " +
    "back a recommendation. Ask at most one clarifying question per turn, and only when one of the three is " +
    "genuinely missing, never a list of questions.\n\n" +
    "Voice: short, sure, chill. 1-3 sentences. No exclamation points, no emoji, no 'Great question', no hype " +
    "words ('unforgettable', 'elevate', 'seamless', 'magical'). Matter-of-fact, then a little warmth. No em " +
    "dashes, use a period or comma instead.\n\n" +
    "You may only recommend items by the exact id given in the catalog below. Never invent an item, id, or price. " +
    "Pick a set of items that fits the occasion, guest count, and budget as closely as possible, favoring a mix " +
    "of categories over many items from one category. If the budget can't be met with real items, get as close " +
    "as you can and say so.\n" +
    (subOcc ? `\nThe customer selected sub-occasion: ${subOcc}.\n` : "") +
    `\nCatalog:\n${catalogText}`;

  let ready = false;
  let message = "";
  let requestedIds: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
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

    const input = toolUse.input as { ready?: unknown; message?: unknown; item_ids?: unknown };
    ready = input.ready === true;
    message = typeof input.message === "string" ? input.message : "";
    requestedIds = Array.isArray(input.item_ids) ? input.item_ids.filter((id): id is string => typeof id === "string") : [];

    if (message.trim().length >= MIN_MESSAGE_LENGTH) {
      break;
    }
    console.warn(`[recommend] attempt ${attempt}: degenerate message ("${message}"), retrying`);
  }

  if (message.trim().length < MIN_MESSAGE_LENGTH) {
    return res.status(502).json({ error: "Model did not return a usable response" });
  }

  if (!ready) {
    return res.json({ ready: false, message });
  }

  const catalogById = new Map(catalogItems.map((item: Item) => [item.id, item]));
  const recommended = requestedIds
    .map((id) => catalogById.get(id))
    .filter((item): item is (typeof catalogItems)[number] => item !== undefined);
  const droppedIds = requestedIds.filter((id) => !catalogById.has(id));

  if (droppedIds.length > 0) {
    console.warn(`[recommend] theme="${theme}": dropped ${droppedIds.length} id(s) not in catalog: ${droppedIds.join(", ")}`);
  }

  const total = recommended.reduce((sum, item) => sum + Number(item.price), 0);

  logLead(account.id, theme, toLeadItems(recommended), total);

  res.json({ ready: true, message, items: recommended, total });
});

export default router;
