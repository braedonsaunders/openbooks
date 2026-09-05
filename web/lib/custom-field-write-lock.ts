import 'server-only';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '@openbooks/engine/src/db.ts';

/** App provenance reserves a table/key across kinds. All definition creators
 * share that namespace, acquiring bundle keys in one order to avoid deadlocks. */
export async function lockCustomFieldKeys(
  tx: SqlExecutor,
  orgId: string,
  fields: readonly { targetTable: string; key: string }[],
): Promise<void> {
  const keys = new Set(fields.map(field => JSON.stringify(['custom-field', orgId, field.targetTable, field.key])));
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
