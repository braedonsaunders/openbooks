import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/** One audit_log row written in the posting's own transaction. */
export interface AuditRecord {
  orgId: string;
  tableName: string;
  rowId: string;
  action: string;
  changes: Record<string, unknown>;
  actorId: string | null;
  requestId: string | null;
}

/** Retains the audit record with the posting; a record that was not retained throws `refusal`. */
export async function insertAuditRecord(
  executor: SqlExecutor,
  record: AuditRecord,
  refusal: () => Error,
): Promise<void> {
  const inserted = await executor.execute<{ id: string }>(
    sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${record.orgId}, ${record.tableName}, ${record.rowId}, ${record.action},
              ${JSON.stringify(record.changes)}::jsonb, ${record.actorId}, ${record.requestId})
      returning id`,
    "objects",
  );
  if (inserted.length !== 1) throw refusal();
}
