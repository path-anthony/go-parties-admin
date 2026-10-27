import { createHmac, timingSafeEqual } from "node:crypto";

// Block T1. A small Stripe client over fetch: Checkout Sessions in embedded
// mode, Customers, Refunds, and webhook signature checks. One pinned API
// version. Tests replace `stripeFetch`; nothing here logs a key, a client
// secret or a card detail.

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION?.trim() || "2025-09-30.clover";

export type StripeFetch = (url: string, init?: RequestInit) => Promise<Response>;
let stripeFetch: StripeFetch = (url, init) => fetch(url, init);
export function setStripeFetch(f: StripeFetch | null) {
  stripeFetch = f ?? ((url, init) => fetch(url, init));
}

export class StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function stripeSecretKey(): string | null {
  const k = process.env.STRIPE_SECRET_KEY?.trim();
  return k ? k : null;
}
export function stripeWebhookSecret(): string | null {
  const k = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return k ? k : null;
}
// Online payment exists only with both: a key to make sessions and a
// webhook secret to learn they were paid.
export function stripeConfigured(): boolean {
  return stripeSecretKey() !== null && stripeWebhookSecret() !== null;
}
export function stripeMode(): "test" | "live" | null {
  const k = stripeSecretKey();
  if (!k) return null;
  return k.startsWith("sk_live_") || k.startsWith("rk_live_") ? "live" : "test";
}

// Stripe takes form bodies with bracketed keys for nested values.
export function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, `${name}[${i}]`));
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`);
      });
    } else if (typeof value === "object") out.push(...formEncode(value as Record<string, unknown>, name));
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

export async function stripeRequest<T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const key = stripeSecretKey();
  if (!key) throw new StripeError(503, "Online payment is not set up.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_API_VERSION,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const body = formEncode(params).join("&");
  const url = method === "GET" ? `${STRIPE_API}${path}${body ? `?${body}` : ""}` : `${STRIPE_API}${path}`;
  let res: Response;
  try {
    res = await stripeFetch(url, { method, headers, body: method === "POST" ? body : undefined, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new StripeError(502, `Stripe could not be reached (${err instanceof Error ? err.name : "error"}).`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; type?: string } } & T;
  if (!res.ok) {
    const e = json.error ?? {};
    throw new StripeError(res.status, e.message ?? `Stripe answered ${res.status}.`, e.code ?? e.type ?? null);
  }
  return json as T;
}

export type CheckoutSession = {
  id: string;
  client_secret: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_intent: string | null;
  customer: string | null;
  amount_total: number | null;
  metadata: Record<string, string>;
};

export type CreateSessionInput = {
  amountCents: number;
  name: string;
  description?: string;
  customerId: string | null;
  customerEmail: string | null;
  metadata: Record<string, string>;
  idempotencyKey: string;
  saveCard: boolean;
};

// An embedded Checkout Session in payment mode with one one-off line item
// built here (no Stripe Products or Prices). The page never redirects: the
// storefront's onComplete fires and it asks the admin whether it is paid.
export function createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession> {
  const params: Record<string, unknown> = {
    ui_mode: "embedded",
    mode: "payment",
    redirect_on_completion: "never",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: input.amountCents, product_data: { name: input.name, ...(input.description ? { description: input.description } : {}) } } }],
    metadata: input.metadata,
    payment_intent_data: { metadata: input.metadata, ...(input.saveCard ? { setup_future_usage: "off_session" } : {}) },
  };
  if (input.customerId) params.customer = input.customerId;
  else if (input.customerEmail) params.customer_email = input.customerEmail;
  return stripeRequest<CheckoutSession>("POST", "/v1/checkout/sessions", params, { idempotencyKey: input.idempotencyKey });
}

export function retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

export function createStripeCustomer(input: { email: string | null; name: string | null; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>("POST", "/v1/customers", { ...(input.email ? { email: input.email } : {}), ...(input.name ? { name: input.name } : {}), metadata: input.metadata }, { idempotencyKey: input.idempotencyKey });
}

export function createRefund(input: { paymentIntentId: string; amountCents: number; idempotencyKey: string; reason?: string }): Promise<{ id: string; amount: number; status: string }> {
  return stripeRequest<{ id: string; amount: number; status: string }>("POST", "/v1/refunds", { payment_intent: input.paymentIntentId, amount: input.amountCents, metadata: { reason: input.reason ?? "" } }, { idempotencyKey: input.idempotencyKey });
}

// ---- webhooks ------------------------------------------------------------------

export const WEBHOOK_TOLERANCE_SECONDS = 300;

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]. The signed payload is
// "<t>.<raw body>" under the endpoint secret. Checked with a constant-time
// compare, and refused when the timestamp is older than the tolerance.
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined, secret: string, now = new Date(), tolerance = WEBHOOK_TOLERANCE_SECONDS): { ok: true } | { ok: false; why: string } {
  if (!header) return { ok: false, why: "missing signature header" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0) return { ok: false, why: "malformed signature header" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, why: "malformed timestamp" };
  if (Math.abs(now.getTime() / 1000 - ts) > tolerance) return { ok: false, why: "timestamp outside tolerance" };
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const e = Buffer.from(expected, "hex");
  const match = sigs.some((s) => {
    const b = Buffer.from(s, "hex");
    return b.length === e.length && timingSafeEqual(b, e);
  });
  return match ? { ok: true } : { ok: false, why: "signature mismatch" };
}

// For tests and local tools: a header Stripe would send for this body.
export function signWebhookPayload(rawBody: string, secret: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export type StripeEventBody = { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
