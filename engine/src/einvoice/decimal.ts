// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Exact decimal helpers for e-invoice amounts, quantities and rates.
 *
 * Money stays on the ledger's BigInt helpers; this file adds what an
 * e-invoice needs beyond them: arbitrary-precision quantities and prices,
 * fixed-decimal rendering, and tolerance comparisons. Nothing here crosses
 * the floating-point boundary.
 */

import { fromUnits, roundDiv, toUnits } from "../money/money.ts";

const PLAIN_DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

export function isPlainDecimal(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= 128 && PLAIN_DECIMAL.test(value.trim());
}

/** An exact rational view of a plain decimal: value = units / 10^scale. */
export interface ExactDecimal {
  units: bigint;
  scale: number;
}

export function exact(value: string): ExactDecimal {
  const raw = value.trim();
  if (raw.length > 128 || !PLAIN_DECIMAL.test(raw)) throw new Error(`not a plain decimal number: "${value}"`);
  const negative = raw.startsWith("-");
  const [whole = "", fraction = ""] = raw.replace(/^[-+]/, "").split(".");
  const units = BigInt(`${whole || "0"}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

function rescale(value: ExactDecimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** Round a plain decimal half away from zero to `places`, returning the scaled integer. */
function roundedUnits(value: string, places: number): bigint {
  const parsed = exact(value);
  if (parsed.scale <= places) return rescale(parsed, places);
  return roundDiv(parsed.units, 10n ** BigInt(parsed.scale - places));
}

function render(units: bigint, places: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, "0");
  const whole = places === 0 ? digits : digits.slice(0, -places);
  const fraction = places === 0 ? "" : `.${digits.slice(-places)}`;
  return `${negative && units !== 0n ? "-" : ""}${whole}${fraction}`;
}

/** A plain decimal written with exactly `places` decimals, rounded half away from zero. */
export function fixed(value: string, places: number): string {
  return render(roundedUnits(value, places), places);
}

/**
 * A quantity or unit price written with at most four decimals and no
 * trailing zeros or exponent ("12.5", "3", "0.1250" → "0.125").
 */
export function trimmed(value: string, maxPlaces = 4): string {
  const text = fixed(value, maxPlaces);
  if (!text.includes(".")) return text;
  const result = text.replace(/0+$/, "").replace(/\.$/, "");
  return result === "-0" ? "0" : result;
}

/** Exact canonical form of a plain decimal: no exponent, no redundant zeros. */
export function canonicalDecimal(value: string): string {
  const parsed = exact(value);
  return trimmed(value, Math.max(parsed.scale, 0));
}

/** Money rounded to the document's currency precision, as a canonical 4-decimal ledger string. */
export function money(value: string, decimals: number): string {
  return fromUnits(toUnits(fixed(value, decimals)));
}

/** True when an amount carries no digits beyond `decimals`. */
export function hasAtMostDecimals(value: string, decimals: number): boolean {
  const parsed = exact(value);
  if (parsed.scale <= decimals) return true;
  return parsed.units % 10n ** BigInt(parsed.scale - decimals) === 0n;
}

/** |a − b| ≤ tolerance, exactly. */
export function within(a: string, b: string, tolerance: string): boolean {
  const left = exact(a);
  const right = exact(b);
  const tol = exact(tolerance);
  const scale = Math.max(left.scale, right.scale, tol.scale);
  const difference = rescale(left, scale) - rescale(right, scale);
  return (difference < 0n ? -difference : difference) <= rescale(tol, scale);
}

/** Compare two plain decimals of any precision: -1, 0 or 1. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const left = exact(a);
  const right = exact(b);
  const scale = Math.max(left.scale, right.scale);
  const difference = rescale(left, scale) - rescale(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/**
 * quantity × price ÷ baseQuantity compared with an amount, within a
 * tolerance, without dividing: |amount·base − quantity·price| ≤ tol·|base|.
 */
export function productWithin(
  amount: string,
  quantity: string,
  price: string,
  baseQuantity: string,
  tolerance: string,
): boolean {
  const values = [exact(amount), exact(quantity), exact(price), exact(baseQuantity), exact(tolerance)];
  const scale = Math.max(...values.map((value) => value.scale));
  const [a, q, p, b, t] = values.map((value) => rescale(value, scale)) as [bigint, bigint, bigint, bigint, bigint];
  const difference = a * b - q * p;
  const magnitude = difference < 0n ? -difference : difference;
  return magnitude <= t * (b < 0n ? -b : b);
}

/**
 * base × percent ÷ 100 compared with an amount, within a tolerance:
 * |amount·100 − base·percent| ≤ tol·100.
 */
export function percentOfWithin(amount: string, base: string, percent: string, tolerance: string): boolean {
  const values = [exact(amount), exact(base), exact(percent), exact(tolerance)];
  const scale = Math.max(...values.map((value) => value.scale));
  const [a, b, p, t] = values.map((value) => rescale(value, scale)) as [bigint, bigint, bigint, bigint];
  const unit = 10n ** BigInt(scale);
  const difference = a * 100n * unit - b * p;
  const magnitude = difference < 0n ? -difference : difference;
  return magnitude <= t * 100n * unit;
}

/** Canonical key for a VAT rate, so "19", "19.0" and "19.0000" group together. */
export function rateKey(rate: string): string {
  return canonicalDecimal(rate);
}

/** True for an absent or zero amount. */
export function isZeroDecimal(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "" || sign(value) === 0;
}

/** Sign of a plain decimal. */
export function sign(value: string): -1 | 0 | 1 {
  return compare(value, "0");
}
