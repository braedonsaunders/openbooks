import { sql } from "drizzle-orm";
import type { db } from "./db.ts";

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

export async function takeEmployeeTaxYearFences(
  tx: Pick<typeof db, "execute">,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
