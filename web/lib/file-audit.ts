import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'

/**
 * File Cabinet activity logging — writes to the shared immutable `audit_log`.
 *
 * The table's `action` column is a fixed enum (insert/update/delete/…), so the
 * specific file verb is carried in `changes.event`; the activity UI reads that.
 * Audit evidence is required: a logging failure must fail the file action.
 * Pass `executor` (a transaction) so evidence commits or rolls back atomically
 * with the mutation it describes; without one it writes on the pooled db.
 */
export type FileEvent =
  | 'create'
  | 'upload'
  | 'rename'
  | 'move'
  | 'replace'
  | 'delete'
  | 'purge'
  | 'restore'
  | 'share'
  | 'unshare'

const EVENT_ACTION: Record<FileEvent, 'insert' | 'update' | 'delete'> = {
  create: 'insert',
  upload: 'insert',
  rename: 'update',
  move: 'update',
  replace: 'update',
  delete: 'delete',
  purge: 'delete',
  restore: 'update',
  share: 'update',
  unshare: 'update',
}

export async function recordFileEvent(input: {
  orgId: string
  actorId: string | null
  table: 'folders' | 'files' | 'file_attachments'
  rowId: string
  action: FileEvent
  changes?: Record<string, unknown>
  /** Transaction seam (same shape as recordTransactionAudit's runner): pass the
   *  caller's tx so a failed insert rolls back the mutation it evidences. */
  executor?: SqlExecutor
}): Promise<void> {
  const executor = input.executor ?? db
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
    values (${input.orgId}, ${input.table}, ${input.rowId}, ${EVENT_ACTION[input.action]},
            ${JSON.stringify({ event: input.action, ...(input.changes ?? {}) })}::jsonb,
            ${input.actorId}, now())
  `)
}

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
