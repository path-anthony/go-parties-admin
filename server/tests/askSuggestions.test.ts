// Block G1. Ask GO's suggested replies. First the checks with no database
// (what a clean suggestion is, who the party is for, the opening lines), then
// the route on a throwaway database with the model replaced: the suggestions
// come from the same call as the reply, fit the conversation, and are an empty
// list when the model sends none or sends rubbish. No test calls Anthropic.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.NODE_ENV = "test";
delete process.env.ANTHROPIC_API_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { MAX_SUGGESTION_WORDS, audienceOf, cleanSuggestions, fitsAudience, starterPrompts } from "../askSuggestions.js";
import { prisma } from "../db.js";
import recommendRouter, { buildSystem, setAskGoModel } from "../routes/recommend.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("askSuggestions.test.ts runs only against a throwaway database (name containing zz_scratch)");

// An em dash, built from its code so this file holds none.
const EM = String.fromCharCode(0x2014);

// ---- the checks, with no database --------------------------------------------------

describe("a clean suggestion", () => {
  test("2 to 4 short lines pass through, tidied: no end punctuation, no emoji, no quotes, no em dash", () => {
    assert.deepEqual(cleanSuggestions(["Under $500", "$500 to $1,000.", "  Not sure yet!  ", '"Around $1,500+"']), ["Under $500", "$500 to $1,000", "Not sure yet", "Around $1,500+"]);
    assert.deepEqual(cleanSuggestions(["Add a bar \u{1F37B}", "Looks good, book it ✨"]), ["Add a bar", "Looks good, book it"]);
    assert.deepEqual(cleanSuggestions([`$500${EM}$800`, "Not sure yet"]), ["$500 to $800", "Not sure yet"]);
  });
  test("at most four, no repeats, and nothing longer than 6 words", () => {
    assert.deepEqual(cleanSuggestions(["One", "Two", "Three", "Four", "Five"]), ["One", "Two", "Three", "Four"]);
    assert.deepEqual(cleanSuggestions(["Not sure yet", "not sure yet", "Next month"]), ["Not sure yet", "Next month"]);
    assert.equal(MAX_SUGGESTION_WORDS, 6);
    assert.deepEqual(cleanSuggestions(["This one has seven words in it", "Keep it under a thousand dollars", "Next month"]), ["Keep it under a thousand dollars", "Next month"]);
  });
  test("none, too few, or malformed is an empty list, never fixed text", () => {
    for (const bad of [undefined, null, "Under $500", 42, {}, { 0: "a", 1: "b" }, [], ["Only one"], [1, 2, 3], [null, {}, ["x"]], ["", "   "], ["Visit https://example.com now", "Email me at a@b.co"]]) {
      assert.deepEqual(cleanSuggestions(bad), [], JSON.stringify(bad));
    }
    assert.deepEqual(cleanSuggestions(["Good one", 7, null, "Another good one"]), ["Good one", "Another good one"], "bad entries are dropped, good ones kept");
  });
});

describe("who the party is for", () => {
  test("adult, kids, or not clear", () => {
    assert.equal(audienceOf("planning a bachelor party for 20"), "adult");
    assert.equal(audienceOf("Bachelor/Bachelorette we need a bar"), "adult");
    assert.equal(audienceOf("my husband's 40th birthday, about 50 people"), "adult");
    assert.equal(audienceOf("company picnic for 100"), "unknown", "families often come: nothing is filtered");
    assert.equal(audienceOf("my daughter is turning 6, 15 kids"), "kids");
    assert.equal(audienceOf("birthday party for a 6 year old"), "kids");
    assert.equal(audienceOf("Sweet 16 for 60"), "kids");
    assert.equal(audienceOf("a birthday party for 30"), "unknown");
    assert.equal(audienceOf("wedding with 20 kids coming"), "unknown", "both kinds of signal: nothing is filtered");
  });
  test("an adult party never gets a line about kids or parents, and the reverse", () => {
    assert.equal(fitsAudience("Add something for the parents", "adult"), false);
    assert.equal(fitsAudience("Something for the kids", "adult"), false);
    assert.equal(fitsAudience("Add a bar", "adult"), true);
    assert.equal(fitsAudience("Add something for the parents", "kids"), true);
    assert.equal(fitsAudience("Add a cigar lounge", "kids"), false);
    assert.equal(fitsAudience("Add something for the parents", "unknown"), true);
    assert.deepEqual(cleanSuggestions(["Add something for the parents", "Keep it under $800", "It might rain"], "adult"), ["Keep it under $800", "It might rain"]);
    assert.deepEqual(cleanSuggestions(["Add something for the parents", "Something for the kids", "Add a bar"], "adult"), [], "fewer than two left: none, not a padded list");
  });
});

describe("opening lines, before anything is typed", () => {
  test("four, one for each kind of party, each short, and they change by day", () => {
    const a = starterPrompts("2026-11-13");
    assert.equal(a.length, 4);
    for (const line of a) assert.ok(line.split(" ").length <= 6 && !/[.!?]$/.test(line), line);
    assert.equal(new Set(a.map((l) => audienceOf(l))).size >= 2, true, "not all one kind of party");
    const days = new Set(["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"].map((d) => starterPrompts(d).join("|")));
    assert.ok(days.size > 1);
    assert.deepEqual(starterPrompts("2026-11-13"), a, "the same all day");
  });
  test("the kind the customer picked on the store leads", () => {
    assert.match(starterPrompts("2026-11-13", "Corporate")[0], /Company|Office|Client|Team/);
    assert.match(starterPrompts("2026-11-13", "wedding")[0], /Wedding|Rehearsal|Engagement|Bridal/);
    assert.equal(starterPrompts("2026-11-13", "something else").length, 4);
  });
});

test("the prompt tells the model how to write them, and the rules for picking items are untouched", () => {
  const text = buildSystem([{ id: "i1", name: "Tent", category: "Tents", price: 450, priceUnit: null }], null).map((b) => b.text).join("\n");
  assert.match(text, /Suggested replies: with every reply, also write 2 to 4 short lines/);
  assert.match(text, /plausible answers to that exact question/);
  assert.match(text, /Never mention kids, children or parents for an adult party/);
  assert.match(text, /6 words or fewer/);
  assert.match(text, /The bar for ready is exactly three signals/);
  assert.match(text, /You may only recommend items by the exact id given in the catalog below/);
  assert.ok(!text.includes(EM));
});

// ---- the route, with the model replaced --------------------------------------------

const ZZ = "ZZTEST G1";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let itemId = "";
let seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
type ToolInput = Record<string, unknown>;
const reply = (input: ToolInput) => {
  setAskGoModel(async (request) => {
    seen.push(request);
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_zz", name: "respond_to_party_request", input }] } as unknown as Pick<Anthropic.Message, "content" | "stop_reason">;
  });
};
const ask = async (messages: { role: string; content: string }[], extra: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/api/recommend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages, ...extra }) });
  return { status: r.status, json: (await r.json()) as { ready: boolean; message: string; suggestions: string[]; items?: { id: string }[]; total?: number } };
};

before(async () => {
  const accountId = (await getDefaultAccount()).id;
  await prisma.item.deleteMany({ where: { name: { startsWith: ZZ } } });
  itemId = (await prisma.item.create({ data: { accountId, name: `${ZZ} Portable Bar`, category: "Bar and Cigar", price: 225 } })).id;
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  // Staff, so the bot check and the public daily cap are out of the way.
  app.use((_req, res, next) => {
    res.locals.isAdmin = true;
    next();
  });
  app.use("/api/recommend", recommendRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  setAskGoModel(null);
  const gone = await prisma.item.deleteMany({ where: { name: { startsWith: ZZ } } });
  console.log("cleanup", JSON.stringify({ items: gone.count, remaining: await prisma.item.count({ where: { name: { startsWith: ZZ } } }) }));
  await prisma.$disconnect();
});

const BACHELOR = [
  { role: "user", content: "Planning a bachelor party for 20" },
];

test("a bachelor party asked for its budget gets budget answers, and nothing about parents or kids", async () => {
  seen = [];
  // The model answers the budget question properly, and also slips in the
  // old kids party line: the backstop drops it.
  reply({ ready: false, message: "Nice, 20 for a bachelor party. What's the budget you're working with?", item_ids: [], suggest_concierge: false, suggestions: ["Under $1,000", "$1,000 to $2,500", "Add something for the parents", "Not sure yet"] });
  const r = await ask(BACHELOR);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.ready, r.json.message], [false, "Nice, 20 for a bachelor party. What's the budget you're working with?"]);
  assert.deepEqual(r.json.suggestions, ["Under $1,000", "$1,000 to $2,500", "Not sure yet"]);
  assert.ok(r.json.suggestions.some((s) => /\$/.test(s)) && r.json.suggestions.includes("Not sure yet"));
  assert.ok(!/parent|kid|child/i.test(r.json.suggestions.join(" ")));
  // One call wrote both the message and the suggestions.
  assert.equal(seen.length, 1);
  const tool = (seen[0].tools as Anthropic.Tool[])[0];
  assert.ok("suggestions" in (tool.input_schema.properties as Record<string, unknown>));
  assert.ok((tool.input_schema.required as string[]).includes("suggestions"));
  assert.deepEqual(seen[0].messages, BACHELOR, "the conversation is sent as it was");
});

test("the old fixed three never come back for an adult party, even if the model sends exactly them", async () => {
  reply({ ready: false, message: "Nice, 20 for a bachelor party. What's the budget you're working with?", item_ids: [], suggest_concierge: false, suggestions: ["Add something for the parents", "Keep it under $800", "It might rain"] });
  const r = await ask(BACHELOR, { subOcc: "Bachelor/Bachelorette" });
  assert.deepEqual(r.json.suggestions, ["Keep it under $800", "It might rain"]);
});

test("a 6 year old's birthday can get family suggestions, with the items and the total as before", async () => {
  seen = [];
  reply({ ready: true, message: "A bar for the grown ups keeps the backyard easy while the kids run around.", item_ids: [itemId, "not-a-real-id"], suggest_concierge: false, suggestions: ["Add something for the parents", "Add a bounce house", "Keep it under $800", "Looks good, book it"] });
  const r = await ask([{ role: "user", content: "Birthday party for my 6 year old, 15 kids, around $900" }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.suggestions, ["Add something for the parents", "Add a bounce house", "Keep it under $800", "Looks good, book it"]);
  // Picking and pricing are untouched: the real item, its catalog price, the made-up id dropped.
  assert.deepEqual([r.json.ready, r.json.items?.map((i) => i.id), r.json.total], [true, [itemId], 225]);
});

test("missing or malformed suggestions are an empty list, the reply still goes out, and nothing is retried", async () => {
  for (const bad of [undefined, null, "Under $500, Not sure yet", { a: "Under $500" }, [], ["Just one"], [42, null], ["This suggestion is far too long to be a button", "So is this other one right here too"]]) {
    seen = [];
    reply({ ready: false, message: "Got it. What's the budget you're working with?", item_ids: [], suggest_concierge: false, ...(bad === undefined ? {} : { suggestions: bad }) });
    const r = await ask(BACHELOR);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.suggestions, [], JSON.stringify(bad));
    assert.equal(r.json.message, "Got it. What's the budget you're working with?");
    assert.equal(seen.length, 1, "bad suggestions are not a reason to call the model again");
  }
});

test("a reply that spends nothing still has the field, empty", async () => {
  const long = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }));
  seen = [];
  const r = await ask(long);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ready, r.json.suggestions, seen.length], [false, [], 0]);
});

test("the opening lines are served with no model call", async () => {
  seen = [];
  const r = await fetch(`${base}/api/recommend/starters`);
  const json = (await r.json()) as { suggestions: string[] };
  assert.equal(r.status, 200);
  assert.equal(json.suggestions.length, 4);
  assert.equal(seen.length, 0);
  const led = (await (await fetch(`${base}/api/recommend/starters?occasion=Corporate`)).json()) as { suggestions: string[] };
  assert.match(led.suggestions[0], /Company|Office|Client|Team/);
});
