import { canonicalDecimal } from "../../../../lib/exact-decimal";

/**
 * PostgreSQL's numeric values are returned as strings by the pg driver. Keep
 * that exact representation at the API boundary instead of coercing ledger
 * amounts through an IEEE-754 number. Bigints are accepted for test doubles
 * and alternate drivers, then converted directly to decimal text.
 */
export function serializeLedgerDecimal(value: unknown): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "number") {
    throw new TypeError("analytics drill ledger decimals must not be JavaScript numbers");
  }
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  const canonical = canonicalDecimal(raw, 4);
  if (canonical === null) throw new TypeError("analytics drill returned an invalid ledger decimal");
  return canonical;
}
