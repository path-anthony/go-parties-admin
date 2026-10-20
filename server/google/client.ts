import { redact } from "../log.js";

// Google's REST APIs with fetch: the OAuth token endpoint, userinfo, the
// Calendar list and the Calendar events. No SDK. Every call goes through
// `googleFetch`, which tests replace. Tokens never appear in an error or a
// log line; errors carry Google's status and reason only.

export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];

export const REDIRECT_URI = "https://go-parties-admin-production.up.railway.app/api/integrations/google/callback";

export type GoogleFetch = (url: string, init?: RequestInit) => Promise<Response>;
let googleFetch: GoogleFetch = (url, init) => fetch(url, init);
export function setGoogleFetch(f: GoogleFetch | null) {
  googleFetch = f ?? ((url, init) => fetch(url, init));
}

export class GoogleError extends Error {
  readonly status: number;
  readonly reason: string;
  // Google said the grant is gone: the user revoked access, or the token expired.
  readonly revoked: boolean;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.revoked = reason === "invalid_grant" || (status === 401 && reason !== "network");
  }
}

export function credentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// What is missing to connect, in plain English, or null when all is set.
export function missingConfig(hasKey: boolean): string | null {
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) missing.push("the Google client ID (GOOGLE_CLIENT_ID)");
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) missing.push("the Google client secret (GOOGLE_CLIENT_SECRET)");
  if (!hasKey) missing.push("a 32-byte token encryption key (GOOGLE_TOKEN_ENCRYPTION_KEY)");
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Google Calendar can't be connected yet: the server is missing ${list}. Add it in Railway and redeploy.`;
}

export function authUrl(state: string, clientId: string): string {
  const u = new URL(OAUTH_AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

async function readError(res: Response): Promise<GoogleError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; error_description?: unknown };
  const err = body.error;
  const reason = typeof err === "string" ? err : typeof (err as { status?: unknown })?.status === "string" ? String((err as { status: string }).status) : typeof (err as { message?: unknown })?.message === "string" ? "api_error" : "unknown";
  const detail = typeof body.error_description === "string" ? body.error_description : typeof (err as { message?: unknown })?.message === "string" ? String((err as { message: string }).message) : "";
  return new GoogleError(res.status, reason, redact(`Google answered ${res.status}${reason !== "unknown" ? ` (${reason})` : ""}${detail ? `: ${detail}` : ""}`).slice(0, 240));
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await googleFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new GoogleError(0, "network", `Google could not be reached: ${err instanceof Error ? redact(err.message) : "network error"}`);
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string };

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const c = credentials();
  if (!c) throw new GoogleError(0, "config", "Google is not configured");
  return call<TokenResponse>(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }).toString(),
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const c = credentials();
  if (!c) throw new GoogleError(0, "config", "Google is not configured");
  const t = await call<TokenResponse>(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }).toString(),
  });
  return t.access_token;
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await call<void>(OAUTH_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
  } catch (err) {
    // An already-revoked token answers 400; that is the state we want.
    if (!(err instanceof GoogleError && err.status === 400)) throw err;
  }
}

export async function userEmail(accessToken: string): Promise<string | null> {
  const u = await call<{ email?: string }>(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  return u.email ?? null;
}

export type CalendarListEntry = { id: string; summary: string; primary?: boolean; accessRole?: string };

export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const r = await call<{ items?: CalendarListEntry[] }>(`${CALENDAR_API}/users/me/calendarList?minAccessRole=writer&maxResults=250`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return (r.items ?? []).map((c) => ({ id: c.id, summary: c.summary, primary: c.primary === true, accessRole: c.accessRole }));
}

export type EventTime = { dateTime: string; timeZone: string } | { date: string };
export type EventPayload = {
  summary: string;
  description: string;
  location: string;
  start: EventTime;
  end: EventTime;
  attendees?: { email: string }[];
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  guestsCanModify?: boolean;
  transparency?: string;
  visibility?: string;
  extendedProperties?: { private: Record<string, string> };
};

const eventsUrl = (calendarId: string, eventId?: string, sendUpdates?: "all" | "none") => {
  const u = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`);
  if (sendUpdates) u.searchParams.set("sendUpdates", sendUpdates);
  return u.toString();
};

export async function insertEvent(accessToken: string, calendarId: string, payload: EventPayload, sendUpdates: "all" | "none"): Promise<{ id: string }> {
  return call<{ id: string }>(eventsUrl(calendarId, undefined, sendUpdates), { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export async function updateEvent(accessToken: string, calendarId: string, eventId: string, payload: EventPayload, sendUpdates: "all" | "none"): Promise<{ id: string }> {
  return call<{ id: string }>(eventsUrl(calendarId, eventId, sendUpdates), { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

// Deleting an event that is already gone is not an error.
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string, sendUpdates: "all" | "none"): Promise<void> {
  try {
    await call<void>(eventsUrl(calendarId, eventId, sendUpdates), { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

export async function getEvent(accessToken: string, calendarId: string, eventId: string): Promise<{ id: string; status?: string } | null> {
  try {
    return await call<{ id: string; status?: string }>(eventsUrl(calendarId, eventId), { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}
