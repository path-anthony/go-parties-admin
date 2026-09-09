import type { Item, Lead, NewItem, RecommendResponse } from "./types";

export const AUTH_EXPIRED_EVENT = "auth:expired";

async function asJson<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function getAuthStatus(): Promise<{ authenticated: boolean }> {
  return fetch("/api/auth/me").then((res) => res.json());
}

export async function login(password: string): Promise<{ ok: true }> {
  // Doesn't go through asJson: a wrong password here is an expected login
  // failure, not an expired session, so it shouldn't fire AUTH_EXPIRED_EVENT.
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? "Login failed");
  }
  return body;
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

export type ItemPatch = Partial<Pick<Item, "name" | "category" | "priceUnit" | "notes" | "photoUrl">> & {
  price?: string | number | null;
};

export function updateItem(id: string, patch: ItemPatch): Promise<Item> {
  return fetch(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(asJson<Item>);
}

export function getLeads(): Promise<Lead[]> {
  return fetch("/api/leads").then(asJson<Lead[]>);
}

export function recommend(theme: string): Promise<RecommendResponse> {
  return fetch("/api/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  }).then(asJson<RecommendResponse>);
}
