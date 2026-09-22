import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Customer } from "../src/generated/prisma/client.js";
import { createSession, findSession, revokeSession, signedCookie } from "./sessions.js";

// Customer sessions live in their own signed cookie, separate from the
// admin's. Both are signed by the same cookie-parser secret (COOKIE_SECRET,
// see index.ts) and both are rows in the same sessions table, but scope is
// by kind: the admin gate accepts only an "admin" row and this gate only a
// "customer" row whose customer still exists. Neither cookie can stand in
// for the other, and a customer's session ends when its row is deleted
// (logout), not when the cookie happens to expire.
export const CUSTOMER_COOKIE = "customer_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// The storefront is a different origin from this API in production, so
// the cookie has to be SameSite=None (which requires Secure) to travel on
// its fetches. Locally both run on localhost and Lax is enough.
function cookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    signed: true,
    httpOnly: true,
    sameSite: production ? ("none" as const) : ("lax" as const),
    secure: production,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

// Called after signup or a correct password: opens a session row for the
// customer and hands its id to the browser.
export async function startCustomerSession(res: Response, customerId: string): Promise<void> {
  const id = await createSession("customer", SESSION_MAX_AGE_MS, customerId);
  res.cookie(CUSTOMER_COOKIE, id, cookieOptions());
}

// Revokes the row behind this browser's cookie, then clears the cookie.
export async function endCustomerSession(req: Request, res: Response): Promise<void> {
  await revokeSession(signedCookie(req, CUSTOMER_COOKIE));
  res.clearCookie(CUSTOMER_COOKIE, { ...cookieOptions(), signed: false, maxAge: undefined });
}

export async function currentCustomer(req: Request): Promise<Customer | null> {
  const session = await findSession(signedCookie(req, CUSTOMER_COOKIE), "customer");
  return session?.customer ?? null;
}

export const requireCustomer: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const customer = await currentCustomer(req);
  if (!customer) {
    return res.status(401).json({ error: "Sign in to continue" });
  }
  res.locals.customer = customer;
  next();
};

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

// Digits only, so "860 555 0134", "(860) 555-0134", and "+1 860-555-0134"
// can't register as three different people.
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export function passwordProblem(value: unknown, ...mustNotEqual: (string | null)[]): string | null {
  if (typeof value !== "string") return "password is required";
  if (value.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (value.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const lowered = value.toLowerCase();
  if (mustNotEqual.some((other) => other && other.toLowerCase() === lowered)) {
    return "password can't be your phone or email";
  }
  return null;
}

// What a customer is allowed to see about themselves. Never the hash.
export function publicCustomer(customer: Customer) {
  return { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, createdAt: customer.createdAt };
}
