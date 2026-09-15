import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Customer } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";

// Customer sessions live in their own signed cookie, separate from the
// admin's. Both are signed by the same cookie-parser secret (see index.ts),
// but scope is by cookie name: the admin gate only reads admin_session and
// only accepts its fixed value, and this gate only reads customer_session
// and only accepts a customer id that still exists. Neither cookie can
// stand in for the other.
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

export function setCustomerSession(res: Response, customerId: string) {
  res.cookie(CUSTOMER_COOKIE, customerId, cookieOptions());
}

export function clearCustomerSession(res: Response) {
  res.clearCookie(CUSTOMER_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

export async function currentCustomer(req: Request): Promise<Customer | null> {
  const id = req.signedCookies?.[CUSTOMER_COOKIE];
  if (typeof id !== "string" || id === "") return null;
  return prisma.customer.findUnique({ where: { id } });
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
