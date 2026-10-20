import { randomBytes } from "node:crypto";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { safeErr } from "../log.js";
import { GoogleError, credentials, exchangeCode, listCalendars, missingConfig, refreshAccessToken, revokeToken, userEmail, type CalendarListEntry } from "./client.js";
import { decryptToken, encryptToken, encryptionKey, signState, verifyState } from "./crypto.js";

// The Google connection: one per account, made once by a Workspace admin
// through OAuth with offline access. The refresh token is kept encrypted;
// an access token is minted from it for each sync and never stored.

export const STATE_TTL_MS = 10 * 60 * 1000;

export class ConnectError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Starts a round trip: a state row tied to the admin session, signed.
export async function beginConnect(sessionId: string): Promise<{ state: string; clientId: string }> {
  const c = credentials();
  const key = encryptionKey();
  const missing = missingConfig(key !== null);
  if (missing || !c) throw new ConnectError(409, missing ?? "Google is not configured.");
  const nonce = randomBytes(18).toString("base64url");
  await prisma.googleOauthState.create({ data: { id: nonce, sessionId, expiresAt: new Date(Date.now() + STATE_TTL_MS) } });
  return { state: signState(nonce, sessionId), clientId: c.clientId };
}

// Spends a state: it must verify for this session, exist, be unexpired and
// unused. The row is marked used in the same step that reads it, so a replay
// is refused even when two callbacks race.
export async function spendState(state: string, sessionId: string, now = new Date()): Promise<boolean> {
  const nonce = verifyState(state, sessionId);
  if (!nonce) return false;
  const spent = await prisma.googleOauthState.updateMany({ where: { id: nonce, sessionId, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  await prisma.googleOauthState.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } }).catch(() => undefined);
  return spent.count === 1;
}

// Finishes a round trip: exchanges the code, keeps the refresh token
// encrypted, records who connected, and picks the primary calendar for GO's
// events when none was chosen before.
export async function finishConnect(code: string): Promise<{ email: string | null }> {
  const key = encryptionKey();
  if (!key) throw new ConnectError(409, missingConfig(false) ?? "Google is not configured.");
  const tokens = await exchangeCode(code);
  if (!tokens.refresh_token) throw new ConnectError(409, "Google did not return a refresh token. Remove the app's access in the Google account's security settings, then connect again.");
  const email = await userEmail(tokens.access_token).catch(() => null);
  const account = await getDefaultAccount();
  const current = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { googleCalendarId: true } });
  let calendarId = current.googleCalendarId;
  if (!calendarId) {
    const calendars = await listCalendars(tokens.access_token).catch(() => [] as CalendarListEntry[]);
    calendarId = calendars.find((c) => c.primary)?.id ?? calendars[0]?.id ?? "primary";
  }
  await prisma.account.update({
    where: { id: account.id },
    data: { googleRefreshTokenEnc: encryptToken(tokens.refresh_token, key), googleConnectedEmail: email, googleConnectedAt: new Date(), googleNeedsReconnect: false, googleCalendarId: calendarId },
  });
  return { email };
}

// Revokes with Google and forgets the token. Event ids on bookings are kept,
// so a reconnect to the same account picks them back up.
export async function disconnect(): Promise<void> {
  const account = await getDefaultAccount();
  const a = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { googleRefreshTokenEnc: true } });
  const key = encryptionKey();
  if (a.googleRefreshTokenEnc && key) {
    try {
      await revokeToken(decryptToken(a.googleRefreshTokenEnc, key));
    } catch (err) {
      console.warn("[google] revoke did not go through:", safeErr(err));
    }
  }
  await prisma.account.update({ where: { id: account.id }, data: { googleRefreshTokenEnc: null, googleConnectedEmail: null, googleConnectedAt: null, googleNeedsReconnect: false } });
}

export type GoogleSettings = {
  connected: boolean;
  email: string | null;
  connectedAt: Date | null;
  calendarId: string | null;
  invitesCalendarId: string | null;
  sendInvites: boolean;
  syncStage: "Confirmed" | "Signed";
  needsReconnect: boolean;
  lastSyncAt: Date | null;
  lastSyncResult: unknown;
  configProblem: string | null;
};

export async function googleSettings(accountId: string): Promise<GoogleSettings> {
  const a = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { googleRefreshTokenEnc: true, googleConnectedEmail: true, googleConnectedAt: true, googleCalendarId: true, googleInvitesCalendarId: true, googleSendInvites: true, googleSyncStage: true, googleNeedsReconnect: true, googleLastSyncAt: true, googleLastSyncResult: true },
  });
  return {
    connected: a.googleRefreshTokenEnc !== null,
    email: a.googleConnectedEmail,
    connectedAt: a.googleConnectedAt,
    calendarId: a.googleCalendarId,
    invitesCalendarId: a.googleInvitesCalendarId,
    sendInvites: a.googleSendInvites,
    syncStage: a.googleSyncStage === "Signed" ? "Signed" : "Confirmed",
    needsReconnect: a.googleNeedsReconnect,
    lastSyncAt: a.googleLastSyncAt,
    lastSyncResult: a.googleLastSyncResult,
    configProblem: missingConfig(encryptionKey() !== null),
  };
}

// An access token for one piece of work. Google refusing the refresh token
// means access was revoked: the account is flagged for reconnection and the
// caller gets a GoogleError with revoked set.
export async function accessToken(accountId: string): Promise<string> {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { googleRefreshTokenEnc: true } });
  const key = encryptionKey();
  if (!a.googleRefreshTokenEnc) throw new GoogleError(0, "not_connected", "Google Calendar is not connected.");
  if (!key) throw new GoogleError(0, "config", missingConfig(false) ?? "Google is not configured.");
  try {
    return await refreshAccessToken(decryptToken(a.googleRefreshTokenEnc, key));
  } catch (err) {
    if (err instanceof GoogleError && err.revoked) {
      await prisma.account.update({ where: { id: accountId }, data: { googleNeedsReconnect: true } }).catch(() => undefined);
    }
    throw err;
  }
}

export async function calendarsFor(accountId: string): Promise<CalendarListEntry[]> {
  return listCalendars(await accessToken(accountId));
}
