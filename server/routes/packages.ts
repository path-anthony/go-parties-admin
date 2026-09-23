import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { INVALID, isOneOf, normalizeText } from "../validate.js";

const PACKAGE_STATUSES = ["Draft", "Published"] as const;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 99;
const MAX_PHOTO_URL_LENGTH = 2_000_000;
const MAX_OCCASIONS = 30;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 40;
const MAX_OCCASION_LENGTH = 60;
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

// A list of short strings: trimmed, de-duplicated case-insensitively
// (first spelling wins), each within a length. Returns a message when
// the shape is wrong.
function stringList(value: unknown, what: string, maxItems: number, maxLength: number): string[] | string {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) return `${what} must be a list of text`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const text = raw.trim();
    if (text === "") continue;
    if (text.length > maxLength) return `each of ${what} must be up to ${maxLength} characters`;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length > maxItems) return `${what} can hold at most ${maxItems} entries`;
  return out;
}

const router = Router();

const WITH_ITEMS = {
  items: {
    include: { item: { select: { id: true, name: true, category: true, price: true, priceUnit: true } } },
    orderBy: { item: { name: "asc" as const } },
  },
};

function normalizePrice(value: unknown): number | typeof INVALID {
  if (value === undefined || value === null || value === "") return INVALID;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : INVALID;
}

type ItemInput = { itemId: string; quantity: number };

// [{ itemId, quantity }], unique items, quantities 1..99, every item on the
// account. Returns a message on any problem.
async function resolveItems(accountId: string, value: unknown): Promise<ItemInput[] | string> {
  if (!Array.isArray(value)) return "items must be an array of { itemId, quantity }";
  if (value.length > MAX_ITEMS) return `items can hold at most ${MAX_ITEMS} entries`;
  const seen = new Set<string>();
  const result: ItemInput[] = [];
  for (const entry of value) {
    const itemId = typeof entry?.itemId === "string" ? entry.itemId : null;
    const quantity = entry?.quantity === undefined ? 1 : entry.quantity;
    if (!itemId) return "each item needs an itemId";
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return `quantity must be a whole number from 1 to ${MAX_QUANTITY}`;
    }
    if (seen.has(itemId)) return "the same item can't be listed twice; raise its quantity instead";
    seen.add(itemId);
    result.push({ itemId, quantity });
  }
  if (result.length > 0) {
    const owned = await prisma.item.count({ where: { id: { in: result.map((r) => r.itemId) }, accountId } });
    if (owned !== result.length) return "items must all be catalog items on this account";
  }
  return result;
}

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const packages = await prisma.package.findMany({
    where: { accountId: account.id },
    include: WITH_ITEMS,
    orderBy: { updatedAt: "desc" },
  });
  res.json(packages);
});

// New packages are always Draft. Publishing is its own deliberate step.
router.post("/", async (req, res) => {
  const body = req.body ?? {};
  const name = normalizeText(body.name);
  if (!name) return res.status(400).json({ error: "name is required" });
  const price = normalizePrice(body.price);
  if (price === INVALID) return res.status(400).json({ error: "price is required and must be a number of 0 or more" });
  if (typeof body.photoUrl === "string" && body.photoUrl.length > MAX_PHOTO_URL_LENGTH) {
    return res.status(400).json({ error: "photoUrl is too large" });
  }

  const account = await getDefaultAccount();
  const items = await resolveItems(account.id, body.items ?? []);
  if (typeof items === "string") return res.status(400).json({ error: items });
  const occasions = stringList(body.occasions ?? [], "occasions", MAX_OCCASIONS, MAX_OCCASION_LENGTH);
  if (typeof occasions === "string") return res.status(400).json({ error: occasions });
  const keywords = stringList(body.keywords ?? [], "keywords", MAX_KEYWORDS, MAX_KEYWORD_LENGTH);
  if (typeof keywords === "string") return res.status(400).json({ error: keywords });

  const created = await prisma.package.create({
    data: {
      accountId: account.id,
      name,
      description: normalizeText(body.description),
      price,
      status: "Draft",
      keywords,
      occasions,
      photoUrl: normalizeText(body.photoUrl),
      items: { create: items.map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity })) },
    },
    include: WITH_ITEMS,
  });
  res.status(201).json(created);
});

// Status is deliberately not editable here; see /publish and /unpublish.
// Edits to a published package go live as soon as they save.
router.patch("/:id", async (req, res) => {
  const id = String(req.params.id);
  const body = req.body ?? {};

  const account = await getDefaultAccount();
  const existing = await prisma.package.findFirst({ where: { id, accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "package not found" });

  const data: {
    name?: string;
    description?: string | null;
    price?: number;
    keywords?: string[];
    occasions?: string[];
    photoUrl?: string | null;
  } = {};
  if ("name" in body) {
    const name = normalizeText(body.name);
    if (!name) return res.status(400).json({ error: "name is required" });
    data.name = name;
  }
  if ("price" in body) {
    const price = normalizePrice(body.price);
    if (price === INVALID) return res.status(400).json({ error: "price must be a number of 0 or more" });
    data.price = price;
  }
  if ("description" in body) data.description = normalizeText(body.description);
  if ("keywords" in body) {
    const keywords = stringList(body.keywords, "keywords", MAX_KEYWORDS, MAX_KEYWORD_LENGTH);
    if (typeof keywords === "string") return res.status(400).json({ error: keywords });
    data.keywords = keywords;
  }
  if ("occasions" in body) {
    const occasions = stringList(body.occasions, "occasions", MAX_OCCASIONS, MAX_OCCASION_LENGTH);
    if (typeof occasions === "string") return res.status(400).json({ error: occasions });
    data.occasions = occasions;
  }
  if ("photoUrl" in body) {
    if (typeof body.photoUrl === "string" && body.photoUrl.length > MAX_PHOTO_URL_LENGTH) {
      return res.status(400).json({ error: "photoUrl is too large" });
    }
    data.photoUrl = normalizeText(body.photoUrl);
  }

  let items: ItemInput[] | null = null;
  if ("items" in body) {
    const resolved = await resolveItems(account.id, body.items);
    if (typeof resolved === "string") return res.status(400).json({ error: resolved });
    items = resolved;
  }
  if (Object.keys(data).length === 0 && items === null) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  const ops = [];
  if (items !== null) {
    ops.push(prisma.packageItem.deleteMany({ where: { packageId: id } }));
    if (items.length > 0) {
      ops.push(prisma.packageItem.createMany({ data: items.map((entry) => ({ packageId: id, itemId: entry.itemId, quantity: entry.quantity })) }));
    }
  }
  await prisma.$transaction([...ops, prisma.package.update({ where: { id }, data })]);

  res.json(await prisma.package.findUniqueOrThrow({ where: { id }, include: WITH_ITEMS }));
});

// A published package has to be findable and sellable: at least one
// occasion so the storefront can ask for it, and at least one item.
router.post("/:id/publish", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.package.findFirst({ where: { id, accountId: account.id }, include: { _count: { select: { items: true } } } });
  if (!existing) return res.status(404).json({ error: "package not found" });

  const missing: string[] = [];
  if (existing.occasions.length === 0) missing.push("at least one occasion");
  if (existing._count.items === 0) missing.push("at least one item");
  if (missing.length > 0) {
    return res.status(400).json({ error: `Can't publish yet: this package needs ${missing.join(" and ")}.` });
  }

  const updated = await prisma.package.update({ where: { id }, data: { status: "Published" }, include: WITH_ITEMS });
  res.json(updated);
});

router.post("/:id/unpublish", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.package.findFirst({ where: { id, accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "package not found" });
  if (!isOneOf(PACKAGE_STATUSES, existing.status)) return res.status(500).json({ error: "unexpected status" });

  const updated = await prisma.package.update({ where: { id }, data: { status: "Draft" }, include: WITH_ITEMS });
  res.json(updated);
});

const SUGGEST_TOOL: Anthropic.Tool = {
  name: "suggest_search_keywords",
  description: "Return short customer-facing search terms for a party package.",
  input_schema: {
    type: "object",
    properties: {
      keywords: {
        type: "array",
        items: { type: "string" },
        description:
          "5 to 8 short terms a real customer might type to find this package: one or two lowercase words each, " +
          "plain everyday language (like 'dogs', 'cartoon', 'toddler', 'outdoor', 'backyard', 'teens'). Themes, " +
          "ages, settings, vibes and what's in it. No prices, no brand names of the company, no repeats of the " +
          "package name as a whole.",
      },
    },
    required: ["keywords"],
  },
};

// Asks Claude for search keywords from what the package is made of. The
// suggestions come back to the admin to edit; nothing is saved here.
router.post("/suggest-keywords", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  const body = req.body ?? {};
  const name = normalizeText(body.name);
  if (!name) return res.status(400).json({ error: "name is required" });
  const occasions = stringList(body.occasions ?? [], "occasions", MAX_OCCASIONS, MAX_OCCASION_LENGTH);
  if (typeof occasions === "string") return res.status(400).json({ error: occasions });
  const itemNames = stringList(body.itemNames ?? [], "itemNames", MAX_ITEMS, 200);
  if (typeof itemNames === "string") return res.status(400).json({ error: itemNames });
  const description = normalizeText(body.description);

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system:
      "You write search keywords for a party rental and event company's storefront. A customer types a word or two " +
      "into a search box to find a package. Give the terms they would actually type: themes, ages, settings, moods, " +
      "and the kinds of things in the package. Short, lowercase, everyday words. No marketing language.",
    messages: [
      {
        role: "user",
        content:
          `Package name: ${name}
` +
          `Occasions: ${occasions.length ? occasions.join(", ") : "not set"}
` +
          `Includes: ${itemNames.length ? itemNames.join(", ") : "no items listed yet"}
` +
          (description ? `Description: ${description}
` : ""),
      },
    ],
    tools: [SUGGEST_TOOL],
    tool_choice: { type: "tool", name: "suggest_search_keywords" },
  });
  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  const raw = (toolUse?.input as { keywords?: unknown } | undefined)?.keywords;
  const keywords = stringList(Array.isArray(raw) ? raw.map((k) => String(k).toLowerCase()) : [], "keywords", MAX_KEYWORDS, MAX_KEYWORD_LENGTH);
  if (typeof keywords === "string" || keywords.length === 0) {
    return res.status(502).json({ error: "The model didn't return usable keywords. Try again." });
  }
  res.json({ keywords });
});

// A real delete. The join rows cascade; nothing else references a package.
router.delete("/:id", async (req, res) => {
  const id = String(req.params.id);
  const account = await getDefaultAccount();
  const existing = await prisma.package.findFirst({ where: { id, accountId: account.id } });
  if (!existing) return res.status(404).json({ error: "package not found" });

  await prisma.package.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
