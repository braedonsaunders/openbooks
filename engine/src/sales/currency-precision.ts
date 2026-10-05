import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * The single Sales-owned ISO quantum resolver. Setup stores fixed amounts
 * as ISO minors and writers quantize to the registry quantum, so every
 * Sales writer and caller resolves precision through this function instead
 * of a local copy. It carries no remedy: it throws the bare
 * UnknownCurrencyPrecisionError and each caller maps it to its own typed
 * refusal, because only the caller knows which workflow the operator was in.
 */
export class UnknownCurrencyPrecisionError extends Error {
  readonly currency: string;
  constructor(currency: string) {
    super(`Currency ${currency} has no usable minor-unit precision in the ISO currency registry`);
    this.name = "UnknownCurrencyPrecisionError";
    this.currency = currency;
  }
}

/**
 * Shared remedy for an unusable registry precision. The registry row is the
 * only thing consulted (no fx edge is declared): a supported-but-missing
 * row is restored by the platform currency seed, while a code outside
 * ISO 4217 never has a row to restore, so the record stays as recorded for
 * original-currency evidence review. Never a teardown, never a rewrite or
 * substitution of posted values; a supported code on a new draft belongs to
 * that draft's own editable workflow, never to this shared helper.
 */
export function currencyPrecisionRemedy(currency: string): string {
  return (
    `If ${currency} is a supported ISO 4217 code, ask your system administrator to restore ` +
    `the missing row with the platform currency seed; otherwise ask your system administrator ` +
    `to review the original currency evidence without changing posted amounts or substituting ` +
    `another currency`
  );
}

export async function resolveCurrencyQuantum(runner: SqlExecutor, currency: string): Promise<number> {
  const row = (await runner.execute<{ minor_units: number | null }>(sql`
    select minor_units from currencies where code = ${currency}
  `)).rows[0];
  const quantum = row?.minor_units;
  if (quantum == null || !Number.isInteger(quantum) || quantum < 0 || quantum > 4) {
    throw new UnknownCurrencyPrecisionError(currency);
  }
  return quantum;
}
