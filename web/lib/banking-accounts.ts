import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * The ONE membership read every banking surface agrees on (F-t06-001).
 *
 * The overview roster, the Match account picker, and the per-account page
 * used to answer "which accounts are banks?" three different ways, so a
 * workspace with underived consolidated rates showed zero accounts on one
 * screen and two on the next. Every surface now filters through
 * `reconcilableBankMembership` (same predicate, same `a` alias for the
 * accounts table); the list/single readers below serve the picker and the
 * account-page guard, while the roster's richer query embeds the same
 * fragment. Subsidiary scoping stays each query's own decision — the
 * overview scopes to its resolved view, the picker and the account page
 * read org-wide — so only membership is unified here, never visibility.
 */

export const BANK_ACCOUNT_TYPES = ['asset_bank', 'liability_card'] as const

export interface ReconcilableBankAccount {
  id: string
  number: string | null
  name: string
  type: string
}

interface ReconcilableBankAccountRow extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
}

/**
 * Shared membership predicate for reconcilable bank/card accounts. Every
 * banking query aliases the accounts table as `a`.
 */
export function reconcilableBankMembership() {
  return sql`a.reconcilable and a.is_active and not a.is_summary and a.type in ('asset_bank', 'liability_card')`
}

/** Every reconcilable bank/card account in the org, by number. */
export async function listReconcilableBankAccounts(orgId: string): Promise<ReconcilableBankAccount[]> {
  const res = await db.execute<ReconcilableBankAccountRow>(sql`
    select a.id, a.number, a.name, a.type
      from accounts a
     where a.org_id = ${orgId} and ${reconcilableBankMembership()}
     order by a.number nulls last
  `)
  return res.rows.map((a) => ({ id: a.id, number: a.number, name: a.name, type: a.type }))
}

/** Membership guard for the per-account page: null reads as a 404. */
export async function reconcilableBankAccount(
  orgId: string,
  accountId: string,
): Promise<ReconcilableBankAccount | null> {
  const res = await db.execute<ReconcilableBankAccountRow>(sql`
    select a.id, a.number, a.name, a.type
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId} and ${reconcilableBankMembership()}
  `)
  const a = res.rows[0]
  return a ? { id: a.id, number: a.number, name: a.name, type: a.type } : null
}
