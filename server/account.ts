import { prisma } from "./db.js";

// Single-tenant today: one seeded Account. Every route resolves "the"
// account through here so swapping in real auth/tenancy later is a
// one-function change, not a rewrite of every route.
type Account = NonNullable<Awaited<ReturnType<typeof prisma.account.findFirst>>>;

// Nearly every request resolves the account first, and there is one row
// that never changes identity, so re-reading it cost a database round trip
// on every call. It is held for a minute. Callers use its id; anything
// that can change (the rush settings) is read fresh in settings.ts.
const ACCOUNT_TTL_MS = 60_000;
let cached: { account: Account; at: number } | null = null;

export async function getDefaultAccount(): Promise<Account> {
  if (cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.account;
  const account = await prisma.account.findFirst({ orderBy: { createdAt: "asc" } });
  if (!account) {
    throw new Error('No account found. Run "npm run db:seed" first.');
  }
  cached = { account, at: Date.now() };
  return account;
}
