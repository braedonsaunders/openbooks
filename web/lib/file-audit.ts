import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * File Cabinet activity logging — writes to the shared immutable `audit_log`.
 *
 * The table's `action` column is a fixed enum (insert/update/delete/…), so the
 * specific file verb is carried in `changes.event`; the activity UI reads that.
 * Writes are best-effort: a logging failure must never fail the user action.
 */
export type FileEvent =
  | 'create'
  | 'upload'
  | 'rename'
  | 'move'
  | 'replace'
  | 'delete'
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
}): Promise<void> {
  try {
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
      values (${input.orgId}, ${input.table}, ${input.rowId}, ${EVENT_ACTION[input.action]},
              ${JSON.stringify({ event: input.action, ...(input.changes ?? {}) })}::jsonb,
              ${input.actorId}, now())
    `)
  } catch {
    // best-effort — never let audit logging break the operation
  }
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
