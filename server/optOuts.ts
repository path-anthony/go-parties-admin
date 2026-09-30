import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";
import { toE164 } from "./messaging.js";

// Phone numbers that must not be texted. Added when Twilio answers 21610
// (the person replied STOP) or by staff from a lead, booking or crew
// record. Every text checks this before it calls Twilio. Email is not
// affected. There is no inbound webhook here, so Twilio's answer is the only
// way the app learns of a STOP.

export async function isOptedOut(phone: string | null | undefined): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  const account = await getDefaultAccount();
  return (await prisma.smsOptOut.findUnique({ where: { accountId_phone: { accountId: account.id, phone: e164 } }, select: { id: true } })) !== null;
}

export async function optedOutSet(accountId: string): Promise<Set<string>> {
  const rows = await prisma.smsOptOut.findMany({ where: { accountId }, select: { phone: true } });
  return new Set(rows.map((r) => r.phone));
}

export async function markOptedOut(phone: string, source: "twilio-21610" | "staff", note?: string | null): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  const account = await getDefaultAccount();
  await prisma.smsOptOut.upsert({
    where: { accountId_phone: { accountId: account.id, phone: e164 } },
    create: { accountId: account.id, phone: e164, source, note: note ?? null },
    update: {},
  });
  return true;
}

export async function clearOptOut(phone: string): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  const account = await getDefaultAccount();
  const res = await prisma.smsOptOut.deleteMany({ where: { accountId: account.id, phone: e164 } });
  return res.count > 0;
}
