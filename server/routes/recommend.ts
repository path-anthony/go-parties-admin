import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import type { Item } from "../../src/generated/prisma/client.js";

const router = Router();

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

const RECOMMEND_TOOL: Anthropic.Tool = {
  name: "recommend_items",
  description: "Return the item ids recommended for the party, and why.",
  input_schema: {
    type: "object",
    properties: {
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of recommended items, taken only from the catalog provided.",
      },
      rationale: {
        type: "string",
        description: "1-3 sentences on why these items fit the theme, in a direct, no-hype tone.",
      },
    },
    required: ["item_ids", "rationale"],
  },
};

router.post("/", async (req, res) => {
  const { theme } = req.body ?? {};
  if (typeof theme !== "string" || theme.trim() === "") {
    return res.status(400).json({ error: "theme is required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  }

  const account = await getDefaultAccount();
  // Only items with a real price can be totaled honestly. TBD/custom-quote
  // items are excluded from what the model is even shown.
  const catalogItems = await prisma.item.findMany({
    where: { accountId: account.id, price: { not: null } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  if (catalogItems.length === 0) {
    return res.json({ theme, rationale: "No priced items in the catalog yet.", items: [], total: 0 });
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
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      "You recommend real party items from a supplied catalog. You may only recommend items by the exact id " +
      "given in the catalog. Never invent an item, id, or price. Pick a set of items that fits the requested " +
      "theme, occasion, guest count, and budget as closely as possible, favoring a mix of categories over " +
      "many items from one category. If the budget can't be met with real items, get as close as you can " +
      "and say so in the rationale.",
    messages: [
      {
        role: "user",
        content: `Theme / occasion: ${theme.trim()}\n\nCatalog:\n${catalogText}`,
      },
    ],
    tools: [RECOMMEND_TOOL],
    tool_choice: { type: "tool", name: "recommend_items" },
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    return res.status(502).json({ error: "Model did not return a recommendation" });
  }

  const input = toolUse.input as { item_ids?: unknown; rationale?: unknown };
  const requestedIds = Array.isArray(input.item_ids) ? input.item_ids.filter((id): id is string => typeof id === "string") : [];
  const rationale = typeof input.rationale === "string" ? input.rationale : "";

  const catalogById = new Map(catalogItems.map((item: Item) => [item.id, item]));
  const recommended = requestedIds
    .map((id) => catalogById.get(id))
    .filter((item): item is (typeof catalogItems)[number] => item !== undefined);
  const droppedCount = requestedIds.length - recommended.length;

  const total = recommended.reduce((sum, item) => sum + Number(item.price), 0);

  res.json({
    theme: theme.trim(),
    rationale,
    items: recommended,
    total,
    ...(droppedCount > 0 ? { note: `${droppedCount} id(s) from the model didn't match the catalog and were dropped.` } : {}),
  });
});

export default router;
