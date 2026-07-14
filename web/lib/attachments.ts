import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Attachment storage — file bytes live IN POSTGRES for now (bytea in
 * `attachment_blobs`; metadata in `attachments`). Every function here is
 * org-scoped: the caller passes the authenticated user's orgId and no row
 * outside that org is ever read, written, or deleted.
 *
 * Object storage is a later swap: `storage_kind` distinguishes 'db' from a
 * future 's3'; only getBlob/createAttachment would branch on it.
 *
 * Raw SQL (not Drizzle table objects) is used deliberately: these tables are
 * exported from schema/src/index.ts by the migration integrator, so this
 * module stays decoupled from that export landing.
 */

export interface AttachmentMeta {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
}

/** Metadata only — never pulls bytes. Ordered newest first. */
export async function listAttachments(
  orgId: string,
  targetTable: string,
  targetId: string,
): Promise<AttachmentMeta[]> {
  const r = (await db.execute(sql`
    select id, filename, content_type as "contentType", size_bytes as "sizeBytes",
           created_at as "createdAt", created_by as "createdBy"
      from attachments
     where org_id = ${orgId} and target_table = ${targetTable} and target_id = ${targetId}
     order by created_at desc
  `)) as unknown as { rows: AttachmentMeta[] }
  return r.rows
}

/** Persist metadata + bytes in one transaction. Returns the new metadata row. */
export async function createAttachment(input: {
  orgId: string
  targetTable: string
  targetId: string
  filename: string
  contentType: string
  bytes: Buffer
  createdBy: string
}): Promise<AttachmentMeta> {
  return db.transaction(async (tx) => {
    const ins = (await tx.execute(sql`
      insert into attachments
        (org_id, target_table, target_id, filename, content_type, size_bytes, storage_kind, created_by)
      values
        (${input.orgId}, ${input.targetTable}, ${input.targetId}, ${input.filename},
         ${input.contentType}, ${input.bytes.length}, 'db', ${input.createdBy})
      returning id, filename, content_type as "contentType", size_bytes as "sizeBytes",
                created_at as "createdAt", created_by as "createdBy"
    `)) as unknown as { rows: AttachmentMeta[] }
    const meta = ins.rows[0]
    await tx.execute(sql`
      insert into attachment_blobs (attachment_id, bytes) values (${meta.id}, ${input.bytes})
    `)
    return meta
  })
}

/** Fetch bytes + the headers needed to stream a download. Org-scoped. */
export async function getBlob(
  orgId: string,
  id: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
  const r = (await db.execute(sql`
    select a.filename, a.content_type as "contentType", b.bytes
      from attachments a
      join attachment_blobs b on b.attachment_id = a.id
     where a.id = ${id} and a.org_id = ${orgId}
  `)) as unknown as { rows: { filename: string; contentType: string; bytes: Buffer }[] }
  return r.rows[0] ?? null
}

/** Look up an attachment's target_table (org-scoped) — for the delete gate. */
export async function getAttachmentTargetTable(
  orgId: string,
  id: string,
): Promise<string | null> {
  const r = (await db.execute(sql`
    select target_table from attachments where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: { target_table: string }[] }
  return r.rows[0]?.target_table ?? null
}

/**
 * Delete an attachment (bytes cascade via the attachment_blobs FK). Returns
 * true when a row in this org was removed, false when nothing matched.
 */
export async function deleteAttachment(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(sql`
    delete from attachments where id = ${id} and org_id = ${orgId} returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}
