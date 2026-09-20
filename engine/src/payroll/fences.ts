import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";

/**
 * Employee × tax-year fences.
 *
 * Every writer that can change what a calculated pay run will pay for an
 * employee's statutory year — the run commit itself, an opening-balance
 * (carry-in) save, a retro settlement — serializes on the same advisory key,
 * so the commit-time freshness gate always sees a world in which the
 * competing write has either fully committed (and is refused as stale) or has
 * not started yet. Keys are taken in sorted order so overlapping rosters
 * queue instead of deadlocking mid-set.
 */
export const employeeTaxYearFenceKey = (
  orgId: string,
  employeePartyId: string | null | undefined,
  taxYear: number | string | null | undefined,
): string => `payroll-run-ytd:${orgId}:${employeePartyId}:${taxYear}`;

/**
 * Employer × tax-year × levy fence.
 *
 * The employee fence cannot serialize employer-aggregate room: two runs on
 * disjoint rosters share no employee key, so both would consume the same
 * threshold allowance and both commit cleanly. Every commit of a run whose
 * pack declares aggregate levies takes the levy's key here (after the
 * employee keys, always in that order, so overlapping commits queue instead
 * of deadlocking), and the employer opening-balance save takes it too — the
 * same doctrine, lifted from employee scope to employer scope.
 */
export const employerLevyFenceKey = (
  orgId: string,
  taxYear: number | string | null | undefined,
  country: string,
  levyKey: string,
): string => `payroll-levy-ytd:${orgId}:${taxYear}:${country}:${levyKey}`;

async function takeFences(
  tx: Pick<typeof db, "execute">,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

export async function takeEmployeeTaxYearFences(
  tx: Pick<typeof db, "execute">,
  keys: readonly string[],
): Promise<void> {
  await takeFences(tx, keys);
}

export async function takeEmployerLevyFences(
  tx: Pick<typeof db, "execute">,
  keys: readonly string[],
): Promise<void> {
  await takeFences(tx, keys);
}
