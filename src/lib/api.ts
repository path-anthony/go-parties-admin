import type { Item, NewItem } from "./types";

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function getItems(): Promise<Item[]> {
  return fetch("/api/items").then(asJson<Item[]>);
}

export function createItem(item: NewItem): Promise<Item> {
  return fetch("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  }).then(asJson<Item>);
}
