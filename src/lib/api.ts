import type {
  AddonGroup,
  AskGoMessage,
  Booking,
  BookingPatch,
  BulkUnitsRequest,
  BulkUnitsResult,
  Item,
  Lead,
  LeadActivity,
  LeadPatch,
  LeadStatus,
  LeadStatusRow,
  NewBooking,
  NewItem,
  NewLead,
  NewUnit,
  Package,
  PackageInput,
  RecommendResponse,
  Unit,
  UnitPatch,
} from "./types";

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

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function getAuthStatus(): Promise<{ authenticated: boolean }> {
  return fetch("/api/auth/me").then((res) => res.json());
}

export async function login(password: string): Promise<{ ok: true }> {
  // Doesn't go through asJson: a wrong password here is an expected login
  // failure, not an expired session, so it shouldn't fire AUTH_EXPIRED_EVENT.
  const res = await fetch("/api/auth/login", jsonRequest("POST", { password }));
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
  return fetch("/api/items", jsonRequest("POST", item)).then(asJson<Item>);
}

export type ItemPatch = Partial<Pick<Item, "name" | "category" | "priceUnit" | "notes" | "photoUrl">> & {
  price?: string | number | null;
};

export function updateItem(id: string, patch: ItemPatch): Promise<Item> {
  return fetch(`/api/items/${id}`, jsonRequest("PATCH", patch)).then(asJson<Item>);
}

export function createAddonGroup(input: { itemId: string; name: string; required: boolean }): Promise<AddonGroup> {
  return fetch("/api/addon-groups", jsonRequest("POST", input)).then(asJson<AddonGroup>);
}

export function updateAddonGroup(id: string, patch: { name?: string; required?: boolean }): Promise<AddonGroup> {
  return fetch(`/api/addon-groups/${id}`, jsonRequest("PATCH", patch)).then(asJson<AddonGroup>);
}

export function deleteAddonGroup(id: string): Promise<{ ok: true }> {
  return fetch(`/api/addon-groups/${id}`, jsonRequest("DELETE")).then(asJson<{ ok: true }>);
}

// The option calls all answer with the whole group, options included.
export function createAddon(groupId: string, input: { name: string; priceDelta: string }): Promise<AddonGroup> {
  return fetch(`/api/addon-groups/${groupId}/addons`, jsonRequest("POST", input)).then(asJson<AddonGroup>);
}

export function updateAddon(groupId: string, addonId: string, patch: { name?: string; priceDelta?: string }): Promise<AddonGroup> {
  return fetch(`/api/addon-groups/${groupId}/addons/${addonId}`, jsonRequest("PATCH", patch)).then(asJson<AddonGroup>);
}

export function deleteAddon(groupId: string, addonId: string): Promise<AddonGroup> {
  return fetch(`/api/addon-groups/${groupId}/addons/${addonId}`, jsonRequest("DELETE")).then(asJson<AddonGroup>);
}

export function getLeads(): Promise<Lead[]> {
  return fetch("/api/leads").then(asJson<Lead[]>);
}

export function createLead(lead: NewLead): Promise<Lead> {
  return fetch("/api/leads", jsonRequest("POST", lead)).then(asJson<Lead>);
}

export function updateLead(id: string, patch: LeadPatch): Promise<Lead> {
  return fetch(`/api/leads/${id}`, jsonRequest("PATCH", patch)).then(asJson<Lead>);
}

// Sends one column's ids in display order; the server sets status and
// sortOrder for all of them. Returns that column, ordered.
export function reorderLeads(status: LeadStatus, ids: string[]): Promise<Lead[]> {
  return fetch("/api/leads/reorder", jsonRequest("PATCH", { status, ids })).then(asJson<Lead[]>);
}

export function getLeadActivity(leadId: string): Promise<LeadActivity[]> {
  return fetch(`/api/leads/${leadId}/activity`).then(asJson<LeadActivity[]>);
}

export function addLeadActivity(leadId: string, text: string): Promise<LeadActivity> {
  return fetch(`/api/leads/${leadId}/activity`, jsonRequest("POST", { text })).then(asJson<LeadActivity>);
}

export function getLeadStatuses(): Promise<LeadStatusRow[]> {
  return fetch("/api/lead-statuses").then(asJson<LeadStatusRow[]>);
}

export function createLeadStatus(name: string): Promise<LeadStatusRow> {
  return fetch("/api/lead-statuses", jsonRequest("POST", { name })).then(asJson<LeadStatusRow>);
}

export function renameLeadStatus(id: string, name: string): Promise<LeadStatusRow> {
  return fetch(`/api/lead-statuses/${id}`, jsonRequest("PATCH", { name })).then(asJson<LeadStatusRow>);
}

export function reorderLeadStatuses(ids: string[]): Promise<LeadStatusRow[]> {
  return fetch("/api/lead-statuses/reorder", jsonRequest("PATCH", { ids })).then(asJson<LeadStatusRow[]>);
}

export function deleteLeadStatus(id: string): Promise<{ ok: true }> {
  return fetch(`/api/lead-statuses/${id}`, jsonRequest("DELETE")).then(asJson<{ ok: true }>);
}

export function getUnits(): Promise<Unit[]> {
  return fetch("/api/units").then(asJson<Unit[]>);
}

export function createUnit(unit: NewUnit): Promise<Unit> {
  return fetch("/api/units", jsonRequest("POST", unit)).then(asJson<Unit>);
}

export function updateUnit(id: string, patch: UnitPatch): Promise<Unit> {
  return fetch(`/api/units/${id}`, jsonRequest("PATCH", patch)).then(asJson<Unit>);
}

export function createUnitsBulk(request: BulkUnitsRequest): Promise<BulkUnitsResult> {
  return fetch("/api/units/bulk", jsonRequest("POST", request)).then(asJson<BulkUnitsResult>);
}

export function getPackages(): Promise<Package[]> {
  return fetch("/api/packages").then(asJson<Package[]>);
}

// Always lands as Draft; publishing is a separate call.
export function createPackage(input: PackageInput): Promise<Package> {
  return fetch("/api/packages", jsonRequest("POST", input)).then(asJson<Package>);
}

export function updatePackage(id: string, input: Partial<PackageInput>): Promise<Package> {
  return fetch(`/api/packages/${id}`, jsonRequest("PATCH", input)).then(asJson<Package>);
}

export function publishPackage(id: string): Promise<Package> {
  return fetch(`/api/packages/${id}/publish`, jsonRequest("POST")).then(asJson<Package>);
}

export function unpublishPackage(id: string): Promise<Package> {
  return fetch(`/api/packages/${id}/unpublish`, jsonRequest("POST")).then(asJson<Package>);
}

export function deletePackage(id: string): Promise<{ ok: true }> {
  return fetch(`/api/packages/${id}`, jsonRequest("DELETE")).then(asJson<{ ok: true }>);
}

export function getBookings(): Promise<Booking[]> {
  return fetch("/api/bookings").then(asJson<Booking[]>);
}

export function createBooking(booking: NewBooking): Promise<Booking> {
  return fetch("/api/bookings", jsonRequest("POST", booking)).then(asJson<Booking>);
}

// unitIds, when present, replaces the booking's whole unit set.
export function updateBooking(id: string, patch: BookingPatch): Promise<Booking> {
  return fetch(`/api/bookings/${id}`, jsonRequest("PATCH", patch)).then(asJson<Booking>);
}

export function recommend(messages: AskGoMessage[], subOcc: string | null = null): Promise<RecommendResponse> {
  return fetch("/api/recommend", jsonRequest("POST", { subOcc, messages })).then(asJson<RecommendResponse>);
}
