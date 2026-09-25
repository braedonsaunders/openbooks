/**
 * Branded money, rate, and quantity types: the ONE canonical decimal boundary.
 *
 * Standing rule MONEY-NUMERIC-ALL: no money value may pass through a JS
 * `number`. These brands are string-backed (`string & { __brand }`) so any
 * `Number(money)`, `parseFloat(money)`, or unary `+money` on a branded
 * identifier is visible to the type checker and refused by
 * `scripts/check-money-brand.mjs`.
 *
 * - `Money` is a canonical ledger amount: fixed numeric(19,4) text
 *   ("123.4500", never "123.45" or 123.45). Parse with `parseMoney` from DB
 *   text or API input; render with `displayMoney`.
 * - `Rate` is a commercial/FX/statutory rate (up to 10 decimal places,
 *   trimmed, e.g. "1.2345"). Sign and range stay the caller's decision: an
 *   FX leg refuses non-positive rates itself, by name, after parsing.
 * - `Quantity` is a measured quantity (up to 8 places, numeric(28,8)).
 *
 * Every function below delegates to the canonical kernel (`money.ts` bigint
 * units, `exact-decimal.ts` grammar) without re-implementing it. No floats,
 * no second grammar, no behaviour of its own.
 */
import { canonicalDecimal, fixedDecimal } from "./exact-decimal.ts";
import { suppliedValue } from "./decimal-refusal.ts";
import {
  add,
  cmp,
  div,
  divRate,
  formatMoney as formatMoneyKernel,
  mul,
  mulRate,
  neg,
  sum,
} from "./money.ts";

export type Money = string & { readonly __brand: "Money" };
export type Rate = string & { readonly __brand: "Rate" };
export type Quantity = string & { readonly __brand: "Quantity" };

/** Canonical zero amount. */
export const ZERO_MONEY: Money = "0.0000" as Money;

function refuse(where: string, raw: unknown): never {
  throw new Error(`${where} must be an exact decimal string — got ${suppliedValue(raw)}`);
}

/**
 * Parse DB text or API input into canonical ledger money (fixed 4dp).
 * Refuses JSON numbers outright: they already crossed IEEE-754 before this
 * boundary sees them, so callers must send the decimal spelling as text.
 */
export function parseMoney(value: unknown): Money {
  const canonical = canonicalDecimal(value, 4);
  if (canonical === null) refuse("money", value);
  return fixedDecimal(canonical, 4) as Money;
}

/** Parse a rate (up to 10 decimal places, trimmed canonical text). */
export function parseRate(value: unknown): Rate {
  const canonical = canonicalDecimal(value, 10);
  if (canonical === null) refuse("rate", value);
  return canonical as Rate;
}

/** Parse a quantity (up to 8 decimal places, trimmed canonical text). */
export function parseQuantity(value: unknown): Quantity {
  const canonical = canonicalDecimal(value, 8);
  if (canonical === null) refuse("quantity", value);
  return canonical as Quantity;
}

/**
 * Arithmetic takes any exact-decimal string (the kernel validates) and
 * returns proven-canonical brands. Input branding lives at the parse
 * boundary (parseMoney/parseRate/parseQuantity); these mark outputs, so
 * internal callers adopt without casts while holders still carry the brand.
 */
export function displayMoney(value: string, decimalPlaces = 2): string {
  return formatMoneyKernel(value, decimalPlaces);
}

export const addMoney = (a: string, b: string): Money => add(a, b) as Money;
/** Subtraction is exact: add the negation, no separate rounding step. */
export const subMoney = (a: string, b: string): Money => add(a, neg(b)) as Money;
export const cmpMoney = (a: string, b: string): -1 | 0 | 1 => cmp(a, b);
export const sumMoney = (values: readonly string[]): Money => sum(values.slice()) as Money;
export const negMoney = (a: string): Money => neg(a) as Money;
export const isZeroMoney = (a: string): boolean => cmp(a, "0") === 0;
/** Money × quantity (unit price × units), rounded once to ledger precision. */
export const mulMoney = (amount: string, quantity: string): Money => mul(amount, quantity) as Money;
/** Money ÷ quantity, rounded once to ledger precision. */
export const divMoney = (amount: string, quantity: string): Money => div(amount, quantity) as Money;
/** Transaction money × FX rate, rounded once to ledger precision. */
export const mulMoneyRate = (amount: string, rate: string): Money => mulRate(amount, rate) as Money;
/** Functional money ÷ FX rate, rounded once to ledger precision. */
export const divMoneyRate = (amount: string, rate: string): Money => divRate(amount, rate) as Money;
