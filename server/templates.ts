import { prisma } from "./db.js";
import { type Channel, type TriggerDef, mustGetTrigger } from "./triggers.js";

// What a message says and whether it is on: the admin's customization if
// there is one, otherwise the registry default.
export type EffectiveTemplate = {
  channel: Channel;
  enabled: boolean;
  subject: string;
  body: string;
  // Wording was edited (a row with a body). Switching a channel off alone
  // is not "customized".
  customized: boolean;
  // A row exists at all (edited or switched off).
  hasRow: boolean;
};

export function defaultsFor(def: TriggerDef, channel: Channel) {
  return {
    enabled: channel === "sms" ? true : def.emailDefaultOn === true,
    subject: channel === "email" ? def.emailSubject : "",
    body: channel === "sms" ? def.sms : def.emailBody,
  };
}

type Row = { triggerKey: string; channel: string; subject: string | null; body: string | null; enabled: boolean };

export function effectiveFrom(triggerKey: string, rows: Row[]): Record<Channel, EffectiveTemplate> {
  const def = mustGetTrigger(triggerKey);
  const build = (channel: Channel): EffectiveTemplate => {
    const d = defaultsFor(def, channel);
    const row = rows.find((r) => r.triggerKey === triggerKey && r.channel === channel);
    if (!row) return { channel, ...d, customized: false, hasRow: false };
    return {
      channel,
      enabled: row.enabled,
      subject: channel === "email" ? (row.subject ?? d.subject) : "",
      body: row.body ?? d.body,
      customized: row.body !== null || (channel === "email" && row.subject !== null),
      hasRow: true,
    };
  };
  return { sms: build("sms"), email: build("email") };
}

export async function getEffectiveTemplates(accountId: string, triggerKey: string): Promise<Record<Channel, EffectiveTemplate>> {
  mustGetTrigger(triggerKey);
  return effectiveFrom(triggerKey, await prisma.messageTemplate.findMany({ where: { accountId, triggerKey } }));
}

// Every customized row in one query, for the scheduler.
export async function loadTemplateRows(accountId: string): Promise<Row[]> {
  return prisma.messageTemplate.findMany({ where: { accountId } });
}
