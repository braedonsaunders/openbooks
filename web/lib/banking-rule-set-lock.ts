import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

/** Serialize rule-set edits with each bulk apply decision for this tenant.
 * Call only inside the transaction that performs the edit or apply. */
export async function lockBankMatchRuleSet(orgId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'bank-match-rule-set:' + orgId}, 0))`)
}
