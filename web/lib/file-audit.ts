import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

/**
 * File Cabinet activity logging — writes to the shared immutable `audit_log`.
 *
 * The table's `action` column is a fixed enum (insert/update/delete/…), so the
 * specific file verb is carried in `changes.event`; the activity UI reads that.
 * Audit evidence is required: a logging failure must fail the file action.
 * Pass `executor` (a transaction) so evidence commits or rolls back atomically
 * with the mutation it describes; without one it writes on the pooled db.
 */
export { recordFileEvent, type FileEvent } from '@openbooks/engine/src/platform/file-audit.ts'

export type FileActivityEntry = {
  id: string
  event: string
  actorId: string | null
  actorName: string | null
  at: string
  changes: Record<string, unknown>
};

/** Activity history for a file or folder, newest first. */
export async function listFileActivity(
  orgId: string,
  table: 'folders' | 'files',
  rowId: string,
  limit = 50,
): Promise<FileActivityEntry[]> {
  const r = (await db.execute<FileActivityEntry>(sql`
    select a.id, coalesce(a.changes->>'event', a.action) as event,
           a.actor_id as "actorId", coalesce(u.name, u.email) as "actorName",
           a.at, a.changes
      from audit_log a
      left join users u on u.id = a.actor_id and u.org_id = ${orgId}
     where a.org_id = ${orgId} and a.table_name = ${table} and a.row_id = ${rowId}
     order by a.at desc
     limit ${limit}
  `))
  return r.rows
}
