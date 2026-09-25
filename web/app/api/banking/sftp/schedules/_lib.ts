import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

/**
 * Account row a schedule binds to, read under the account row lock.
 *
 * The account PATCH writer (`web/app/api/accounts/[id]/route.ts`) holds
 * `for update` on this same row while changing `subsidiary_id`, so any
 * schedule write that locks the row first and rechecks scope inside its own
 * transaction has a deterministic order with a concurrent rehome: either the
 * rehome commits first and the recheck sees the new subsidiary, or the
 * schedule write commits first and the rehome then moves a bound schedule
 * (whose existing binding the import path re-derives per write).
 */
export interface LockedScheduleAccount {
  subsidiary_id: string | null;
  reconcilable: boolean;
  is_active: boolean;
  is_summary: boolean;
  currency: string | null;
}

/**
 * Lock the bound bank account row for a schedule write. Returns null when
 * the account is missing or foreign-tenant (same treatment as ineligible).
 */
export async function lockScheduleAccount(
  tx: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<LockedScheduleAccount | null> {
  return (await tx.execute<LockedScheduleAccount & Record<string, unknown>>(sql`
    select subsidiary_id, reconcilable, is_active, is_summary,
           currency_restriction as currency
      from accounts
     where id = ${accountId} and org_id = ${orgId}
     for update
  `)).rows[0] ?? null
}
