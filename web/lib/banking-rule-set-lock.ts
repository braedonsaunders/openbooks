import { sql } from 'drizzle-orm'
import { db, orgContext, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

/**
 * Serialize rule-set edits with each bulk apply decision for this tenant.
 *
 * The lock is transaction-scoped, so it must be taken on the connection of
 * the transaction that performs the edit or apply: pass that transaction's
 * handle (`tx` from `db.transaction`), or `db` only inside a pinned org
 * transaction (`withOrgTransaction`). Taken on the pool it would run as its
 * own autocommit statement and release before the edit even begins, so that
 * call is refused instead.
 */
export async function lockBankMatchRuleSet(tx: SqlExecutor, orgId: string): Promise<void> {
  if (tx === db && !orgContext.getStore()?.txDb) {
    throw new Error('the bank rule-set lock must be taken on the transaction that performs the edit or apply')
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'bank-match-rule-set:' + orgId}, 0))`)
}
