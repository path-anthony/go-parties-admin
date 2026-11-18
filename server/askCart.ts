import { isPerGuestUnit } from "./pricing.js";

// Block FIX1. Ask GO and the customer's cart. The store sends the cart it has
// with every message; the model answers with a cart action (none, add,
// remove, replace) and the items it applies to; this file works out the cart
// that results. Pure. Every id is read against the catalog, so a cart line
// is always a real, public, priced item, and nothing the store typed reaches
// the model.

export type CartAction = "none" | "add" | "remove" | "replace";
export type CartLine = { id: string; name: string; price: number | null; priceUnit: string | null; quantity: number; perGuest: boolean };
type CatalogItem = { id: string; name: string; price: unknown; priceUnit: string | null };

export const MAX_CART_LINES = 50;

const lineFor = (item: CatalogItem, quantity = 1): CartLine => ({
  id: item.id,
  name: item.name,
  price: item.price === null || item.price === undefined ? null : Number(item.price),
  priceUnit: item.priceUnit,
  quantity: isPerGuestUnit(item.priceUnit) ? 1 : quantity,
  perGuest: isPerGuestUnit(item.priceUnit),
});

// The cart the store sent: [{ itemId, quantity? }] (or plain ids). Unknown or
// hidden ids are dropped, repeats merged, quantities kept to 1 to 50.
export function parseAskCart(value: unknown, catalog: Map<string, CatalogItem>): CartLine[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, CartLine>();
  for (const entry of value.slice(0, MAX_CART_LINES)) {
    const id = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { itemId?: unknown; id?: unknown }).itemId ?? (entry as { id?: unknown }).id : null;
    if (typeof id !== "string") continue;
    const item = catalog.get(id);
    if (!item || out.has(id)) continue;
    const q = entry && typeof entry === "object" ? (entry as { quantity?: unknown }).quantity : 1;
    out.set(id, lineFor(item, typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= 50 ? q : 1));
  }
  return [...out.values()];
}

// The cart after the action. Ids not in the catalog are ignored.
export function applyCartAction(current: CartLine[], action: CartAction, ids: string[], catalog: Map<string, CatalogItem>): CartLine[] {
  const known = [...new Set(ids)].map((id) => catalog.get(id)).filter((i): i is CatalogItem => i !== undefined);
  if (action === "none") return current;
  if (action === "replace") return known.map((i) => current.find((l) => l.id === i.id) ?? lineFor(i));
  if (action === "remove") {
    const drop = new Set(known.map((i) => i.id));
    return current.filter((l) => !drop.has(l.id));
  }
  const have = new Set(current.map((l) => l.id));
  return [...current, ...known.filter((i) => !have.has(i.id)).map((i) => lineFor(i))];
}

// Whether the customer's latest message asks for a change to the cart. A
// backstop behind the prompt's own rule: a question about delivery, space or
// rain that names no change keeps the cart. Kept generous on purpose: any
// word that could be a change request counts as one.
const CHANGE = /\b(add|adding|include|throw in|remove|drop|take (it |that |them )?(out|off)|without|no more|get rid of|swap|switch|replace|instead|change|lower|cheaper|for less|reduce|cut|trim|under \$?\d|keep it (under|below)|bigger|smaller|larger|upgrade|downgrade|rebuild|start over|redo|another one|other options?|alternatives?|i'?d rather|we'?d rather|i (want|would like)|we (want|would like)|can (we|i|you) (get|have|do)|let'?s (do|go|add)|book it|looks good|go with|show me|build|suggest|recommend|more (items|stuff|for|food|drinks|games|fun)|make it)\b/i;

const QUESTION = /\?\s*$|^\s*(what|what's|whats|how|do|does|did|is|are|can|could|will|would|when|where|who|which|should|if|any|anything)\b/i;

// Only a message that is a question, and names no change, keeps the cart
// whatever the model says. An answer to Ask GO's own question ("about 50
// guests", "$2,000") may still change it.
export function wantsCartChange(text: string): boolean {
  if (CHANGE.test(text)) return true;
  return !QUESTION.test(text.trim());
}
