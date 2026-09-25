/** Split from web/lib/file-cabinet.ts (ARCH-FILE-SPLIT; pure moves only). */
import 'server-only'
import { titleizeKind } from './shared'
import { sql } from 'drizzle-orm'
import { db, inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'


/**
 * Ensure the org has its system "Attachments" root folder. Auto-created on
 * first use. Returns the folder id.
 */
export async function ensureAttachmentsRoot(orgId: string, executor?: SqlExecutor): Promise<string> {
  const work = async (tx: SqlExecutor): Promise<string> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments-root:${orgId}`}))`)
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders
       where org_id = ${orgId} and system_kind = 'attachments'
    `))
    if (existing.rows.length > 0) return existing.rows[0]!.id
    const ins = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now())
      returning id
    `))
    return ins.rows[0]!.id
  }
  return executor ? work(executor) : inDbTransaction(work)
}

/** System intake folder for AP capture source packets. */
export async function ensureApCaptureRoot(orgId: string, createdBy: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ap-capture:${orgId}`}))`)
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and system_kind = 'ap_capture'
    `))
    if (existing.rows[0]) return existing.rows[0]!.id
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, is_private, owner_id,
                           created_by, updated_by, created_at, updated_at)
      values (${orgId}, 'AP Capture', true, 'ap_capture', false, null,
              ${createdBy}, ${createdBy}, now(), now())
      returning id
    `))
    return inserted.rows[0]!.id
  })
}

/**
 * Ensure the kind group folder for a record type exists under the Attachments
 * root, and return its id. Group folders (record_id null, record_table set)
 * tuck the per-record leaf folders one level deeper so the cabinet home screen
 * and sidebar never enumerate tens of thousands of attachment folders. For
 * `documents` the group is the document kind ("Vendor Bill", "Expense Report");
 * for any other table it is the titleized table name. Matched by name so it
 * stays in lock-step with the SQL backfill.
 */
async function ensureGroupFolder(
  orgId: string,
  rootId: string,
  recordTable: string,
  label: string,
  executor?: SqlExecutor,
): Promise<string> {
  const work = async (tx: SqlExecutor): Promise<string> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attach-group:${orgId}:${label}`}))`)
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders
       where org_id = ${orgId} and parent_folder_id = ${rootId}
         and record_id is null and name = ${label}
    `))
    if (existing.rows[0]) return existing.rows[0]!.id
    const ins = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, ${label}, true, ${recordTable}, now(), now())
      returning id
    `))
    return ins.rows[0]!.id
  }
  return executor ? work(executor) : inDbTransaction(work)
}

/** Resolve the kind group label for a record: document kind for `documents`,
 *  else the titleized table name. Falls back to "Documents" for orphaned rows. */
async function groupLabelFor(orgId: string, recordTable: string, recordId: string, executor?: SqlExecutor): Promise<string> {
  if (recordTable !== 'documents') return titleizeKind(recordTable)
  const r = (await (executor ?? db).execute<{ kind: string | null }>(sql`
    select kind from documents where id = ${recordId} and org_id = ${orgId}
  `))
  const kind = r.rows[0]?.kind
  return kind ? titleizeKind(kind) : 'Documents'
}

/**
 * Ensure a per-record attachment folder exists, nested under its kind group
 * folder (Attachments / <Group> / <record>). One leaf per (org, recordTable,
 * recordId). Returns the folder id.
 */
export async function ensureRecordFolder(
  orgId: string,
  recordTable: string,
  recordId: string,
  executor?: SqlExecutor,
): Promise<string> {
  const work = async (tx: SqlExecutor): Promise<string> => {
    // There is deliberately no unique constraint on the nullable record key;
    // serialize this lookup/insert pair so concurrent attachment uploads share
    // one per-record folder instead of creating duplicate system folders.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attach-record:${orgId}:${recordTable}:${recordId}`}))`)
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders
       where org_id = ${orgId} and record_table = ${recordTable} and record_id = ${recordId}
         and record_id is not null
       for share
    `))
    if (existing.rows.length > 0) return existing.rows[0]!.id
    const rootId = await ensureAttachmentsRoot(orgId, tx)
    const label = await groupLabelFor(orgId, recordTable, recordId, tx)
    const groupId = await ensureGroupFolder(orgId, rootId, recordTable, label, tx)
    const name = `${recordTable} / ${recordId.slice(0, 8)}`
    const ins = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
      values (${orgId}, ${groupId}, ${name}, true, ${recordTable}, ${recordId}, now(), now())
      returning id
    `))
    return ins.rows[0]!.id
  }
  return executor ? work(executor) : inDbTransaction(work)
}
