import type { Request } from "express";
import { currentCustomer } from "./customerAuth.js";
import { safeInline, stripControl } from "./sanitize.js";
import { looksLikeEmail, normalizeText } from "./validate.js";

// Block F2. Who a lead from Ask GO or "Talk to us instead" is. A lead is only
// worth keeping when staff can reach somebody: at least one of a name, an
// email or a phone. What was sent with the request comes first; a signed-in
// customer's account fills what is missing. Returns null when there is none
// of the three, and then no lead is made.
export type LeadContact = { name: string | null; phone: string | null; email: string | null };

export async function leadContactFrom(req: Request, body: Record<string, unknown>): Promise<LeadContact | null> {
  const customer = await currentCustomer(req).catch(() => null);
  const text = (v: unknown, max: number) => {
    const raw = typeof v === "string" && v.length <= 400 ? normalizeText(v) : null;
    return raw ? stripControl(raw, max) || null : null;
  };
  const typedName = text(body.name ?? body.customerName, 100);
  const name = (typedName ? safeInline(typedName, 100) || null : null) ?? (customer?.name ? safeInline(customer.name, 100) || null : null);
  const typedEmail = text(body.email, 200);
  const email = (typedEmail && looksLikeEmail(typedEmail) ? typedEmail : null) ?? customer?.email ?? null;
  const typedPhone = text(body.phone, 40);
  const digits = typedPhone ? typedPhone.replace(/\D/g, "").length : 0;
  const phone = (typedPhone && digits >= 7 && digits <= 15 ? typedPhone : null) ?? customer?.phone ?? null;
  if (!name && !email && !phone) return null;
  return { name, phone, email };
}

// "8605550142 \u00b7 sarah@example.com", the way a storefront booking's lead reads.
export const contactLine = (c: LeadContact): string | null => [c.phone, c.email].filter(Boolean).join(" \u00b7 ") || null;
