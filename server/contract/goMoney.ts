// Contract money, in integer cents, rounded half up at every step the form
// calls (AUTO). Pure.

export type GoTotals = {
  subtotal: number;
  totalDiscount: number;
  total: number;
  retainer: number;
  balance: number;
};

// Half-up rounding of a non-negative number to the nearest integer.
export const roundHalfUp = (n: number): number => Math.floor(n + 0.5);

export const toCents = (dollars: number): number => roundHalfUp(dollars * 100);

// Services Subtotal = all fees added.
// Total Discount = Discount % x Subtotal + Discount $.
// Total Contracted Amount = Subtotal minus Total Discount (never below 0).
// Retainer = retainer % of the Total; Balance = Total minus retainer.
export function goTotals(input: { feesCents: number[]; discountPercent: number | null; discountAmountCents: number | null; retainerPercent: number }): GoTotals {
  const subtotal = input.feesCents.reduce((sum, f) => sum + f, 0);
  const pct = input.discountPercent ?? 0;
  const totalDiscount = Math.min(subtotal, roundHalfUp((subtotal * pct) / 100) + (input.discountAmountCents ?? 0));
  const total = Math.max(0, subtotal - totalDiscount);
  const retainer = roundHalfUp((total * input.retainerPercent) / 100);
  return { subtotal, totalDiscount, total, retainer, balance: total - retainer };
}

// "$50" for a whole number of dollars, "$50.50" otherwise: how the contract's
// own text writes a fee.
export function wholeDollars(dollars: number): string {
  const cents = toCents(dollars);
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// A date `days` before an event day (YYYY-MM-DD), as YYYY-MM-DD.
export function daysBefore(day: string, days: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}
