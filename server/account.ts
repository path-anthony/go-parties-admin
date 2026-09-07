import { prisma } from "./db.js";

// Single-tenant today: one seeded Account. Every route resolves "the"
// account through here so swapping in real auth/tenancy later is a
// one-function change, not a rewrite of every route.
export async function getDefaultAccount() {
  const account = await prisma.account.findFirst({ orderBy: { createdAt: "asc" } });
  if (!account) {
    throw new Error('No account found. Run "npm run db:seed" first.');
  }
  return account;
}
