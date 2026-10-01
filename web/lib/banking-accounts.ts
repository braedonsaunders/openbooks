import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

/** Bank account membership and reconciliation eligibility share the same
 * active leaf-account policy. Visibility does not require reconciliation
 * setup: the overview and detail pages include every bank/card account;
 * import and Match pickers additionally require the reconcilable flag.
 * Each caller continues to enforce its own subsidiary scope. */

export interface ReconcilableBankAccount {
  id: string
  number: string | null
  name: string
  type: string
  /** Owning subsidiary; null = shared. Scoping stays each query's decision. */
  subsidiaryId: string | null
}

interface ReconcilableBankAccountRow extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
  subsidiaryId: string | null
}

/**
 * Shared membership predicate for reconcilable bank/card accounts. Every
 * banking query aliases the accounts table as `a`.
 */
export function reconcilableBankMembership() {
  return sql`${bankAccountMembership()} and a.reconcilable`
}

/** All active bank/card leaf accounts, including those awaiting setup. */
export function bankAccountMembership() {
  return sql`a.is_active and not a.is_summary and a.type in ('asset_bank', 'liability_card')`
}

/** Detail-page membership; reconciliation eligibility is exposed separately. */
export async function bankAccount(orgId: string, accountId: string): Promise<(ReconcilableBankAccount & { reconcilable: boolean }) | null> {
  const res = await db.execute<ReconcilableBankAccountRow & { reconcilable: boolean }>(sql`
    select a.id, a.number, a.name, a.type, a.subsidiary_id as "subsidiaryId", a.reconcilable
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId} and ${bankAccountMembership()}
  `)
  return res.rows[0] ?? null
}

/** Every reconcilable bank/card account in the org, by number. */
export async function listReconcilableBankAccounts(orgId: string): Promise<ReconcilableBankAccount[]> {
  const res = await db.execute<ReconcilableBankAccountRow>(sql`
    select a.id, a.number, a.name, a.type, a.subsidiary_id as "subsidiaryId"
      from accounts a
     where a.org_id = ${orgId} and ${reconcilableBankMembership()}
     order by a.number nulls last
  `)
  return res.rows.map((a) => ({ id: a.id, number: a.number, name: a.name, type: a.type, subsidiaryId: a.subsidiaryId }))
}

/** Read a bank/card account eligible for reconciliation: null means ineligible. */
export async function reconcilableBankAccount(
  orgId: string,
  accountId: string,
): Promise<ReconcilableBankAccount | null> {
  const res = await db.execute<ReconcilableBankAccountRow>(sql`
    select a.id, a.number, a.name, a.type, a.subsidiary_id as "subsidiaryId"
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId} and ${reconcilableBankMembership()}
  `)
  const a = res.rows[0]
  return a ? { id: a.id, number: a.number, name: a.name, type: a.type, subsidiaryId: a.subsidiaryId } : null
}

interface OpeningCarryRow extends Record<string, unknown> {
  start_date: string | null
}

/**
 * The ONE opening-carry read every GL candidate list agrees on.
 *
 * The engine persists the first reconciliation's proven statement opening in
 * that sign-off's audit record (see `firstReconciliationCarry` in
 * engine/src/banking/banking.ts); pre-coverage ledger lines are cleared by that
 * carry, so candidate lists must stop offering them for matching. The
 * earliest signed-off session wins, matching the engine's reuse rule.
 */
export async function openingCarryStartDate(
  orgId: string,
  accountId: string,
): Promise<string | null> {
  const res = await db.execute<OpeningCarryRow>(sql`
    select al.changes->>'openingCarryStartDate' as start_date
      from audit_log al
      join reconciliations r on r.id = al.row_id and r.org_id = al.org_id
     where al.org_id = ${orgId}
       and al.table_name = 'reconciliations'
       and al.action = 'approve'
       and r.account_id = ${accountId}
       and r.status = 'signed_off'
       and (al.changes->>'openingCarriedForward') is not null
       and (al.changes->>'openingCarriedForward')::numeric <> 0
       and (al.changes->>'openingCarryStartDate') is not null
     order by r.through_date asc, r.created_at asc, r.id asc
     limit 1
  `)
  return res.rows[0]?.start_date ?? null
}
