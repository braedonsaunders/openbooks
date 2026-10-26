import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/** App provenance and field definitions share one table/key namespace. */
export async function lockCustomFieldKeys(
  tx: SqlExecutor,
  orgId: string,
  fields: readonly { targetTable: string; key: string }[],
): Promise<void> {
  const keys = new Set(
    fields.map((field) => JSON.stringify(["custom-field", orgId, field.targetTable, field.key])),
  );
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
