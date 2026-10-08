import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";

export type FileEvent =
  | 'create'
  | 'upload'
  | 'rename'
  | 'move'
  | 'replace'
  | 'delete'
  | 'purge'
  | 'restore'
  | 'update'
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
  update: 'update',
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
  const written = await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
    values (${input.orgId}, ${input.table}, ${input.rowId}, ${EVENT_ACTION[input.action]},
            ${JSON.stringify({ event: input.action, ...(input.changes ?? {}) })}::jsonb,
            ${input.actorId}, now()) returning id
  `)
  if (written.rows.length !== 1) throw new Error('File activity audit did not persist')
}
