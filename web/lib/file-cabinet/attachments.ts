/** Split from web/lib/file-cabinet.ts; moved without behavior changes. */
import 'server-only'
import { ensureRecordFolder } from './system-folders'
import { createFile, RETAINED_ATTACHMENT, lockRetainedAttachmentTarget } from './files'
import { type FileMutationAudit, runMutation } from './mutation'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { recordFileEvent } from '../file-audit'

// --- file attachments (links to records) ------------------------------------

export type AttachedFile = {
  id: string
  name: string
  fileType: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
  attachmentId: string
};

/** List files attached to a record (metadata only, no bytes). */
export async function listAttachments(
  orgId: string,
  targetTable: string,
  targetId: string,
): Promise<AttachedFile[]> {
  const r = (await db.execute<AttachedFile>(sql`
    select fi.id, fi.name, fi.file_type as "fileType", fi.content_type as "contentType",
           fi.size_bytes as "sizeBytes", fa.created_at as "createdAt",
           fa.created_by as "createdBy", fa.id as "attachmentId"
      from file_attachments fa
      join files fi on fi.id = fa.file_id and fi.org_id = fa.org_id
     where fa.org_id = ${orgId} and fa.target_table = ${targetTable} and fa.target_id = ${targetId}
     order by fa.created_at desc
  `))
  return r.rows
}

/**
 * Upload a file and attach it to a record in one operation. Auto-creates a
 * per-record folder under the "Attachments" system root. This is the
 * AttachmentPanel's upload path.
 */
export async function uploadAndAttach(input: {
  orgId: string
  targetTable: string
  targetId: string
  filename: string
  contentType: string
  bytes: Buffer
  createdBy: string | null
  /** Optional caller-owned transaction (invoice-backup replacement). */
  executor?: SqlExecutor
  /** Recheck the caller's target scope and write permission under its row lock. */
  authorizeTarget?: (executor: SqlExecutor) => Promise<void>
}): Promise<AttachedFile> {
  return runMutation(input.executor, async (tx) => {
    await input.authorizeTarget?.(tx)
    const folderId = await ensureRecordFolder(input.orgId, input.targetTable, input.targetId, tx)
    const file = await createFile({
      orgId: input.orgId,
      folderId,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
      createdBy: input.createdBy,
      audit: { actorId: input.createdBy, executor: tx },
    })
    const attIns = (await tx.execute<{ id: string }>(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
      values (${input.orgId}, ${file.id}, ${input.targetTable}, ${input.targetId},
              ${input.createdBy}, now())
      returning id
    `))
    return {
      id: file.id,
      name: file.name,
      fileType: file.fileType,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      createdAt: file.createdAt,
      createdBy: input.createdBy,
      attachmentId: attIns.rows[0]!.id,
    }
  })
}

/** Attach an existing file to a record (no upload). Idempotent. */
export async function attachExisting(input: {
  orgId: string
  fileId: string
  targetTable: string
  targetId: string
  createdBy: string
  executor?: SqlExecutor
  authorizeTarget?: (executor: SqlExecutor) => Promise<void>
}): Promise<string | null> {
  return runMutation(input.executor, async (tx) => {
    await input.authorizeTarget?.(tx)
    const r = (await tx.execute<{ id: string }>(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
      values (${input.orgId}, ${input.fileId}, ${input.targetTable}, ${input.targetId},
              ${input.createdBy}, now())
      on conflict (org_id, file_id, target_table, target_id) do nothing
      returning id
    `))
    return r.rows[0]?.id ?? null
  })
}

export type AttachmentLink = {
  id: string
  fileId: string
  targetTable: string
  targetId: string
}

export type DetachOutcome = { ok: true } | { ok: false; reason: 'not found' | 'retained' }

/**
 * Detach a file from a record (does NOT delete the file). Refuses when the
 * link is retained evidence (RETAINED_ATTACHMENT: posted document, in-force
 * compliance record, fixed asset) — otherwise detaching would be the way
 * around purge's retention guard. The target row is locked before the link
 * and retention recheck, so posting cannot slip between the decision and the delete. With
 * `audit`, the delete and its actor-attributed before-evidence commit as one
 * unit.
 */
export async function detachAttachment(
  orgId: string,
  attachmentId: string,
  audit?: FileMutationAudit,
): Promise<DetachOutcome> {
  return runMutation(audit?.executor, async (tx) => {
    const identity = (await tx.execute<{ fileId: string; targetTable: string; targetId: string }>(sql`
      select file_id as "fileId", target_table as "targetTable", target_id as "targetId"
        from file_attachments
       where id = ${attachmentId} and org_id = ${orgId}
    `)).rows[0]
    if (!identity) return { ok: false as const, reason: 'not found' as const }
    await audit?.authorizeAttachmentTarget?.(tx, identity)
    await lockRetainedAttachmentTarget(tx, orgId, identity.targetTable, identity.targetId)
    const link = (await tx.execute<{ fileId: string; targetTable: string; targetId: string; retained: boolean }>(sql`
      select fa.file_id as "fileId", fa.target_table as "targetTable", fa.target_id as "targetId",
             ${RETAINED_ATTACHMENT} as retained
        from file_attachments fa
       where fa.id = ${attachmentId} and fa.org_id = ${orgId}
       for update of fa
    `)).rows[0]
    if (!link) return { ok: false as const, reason: 'not found' as const }
    if (link.retained) return { ok: false as const, reason: 'retained' as const }
    await tx.execute(sql`delete from file_attachments where id = ${attachmentId} and org_id = ${orgId}`)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'file_attachments',
        rowId: attachmentId,
        action: 'delete',
        changes: { before: { fileId: link.fileId, targetTable: link.targetTable, targetId: link.targetId } },
        executor: tx,
      })
    }
    return { ok: true as const }
  })
}

/** The full attachment link (file + target) for permission and scope gating. */
export async function getAttachmentLink(orgId: string, attachmentId: string): Promise<AttachmentLink | null> {
  const r = (await db.execute<AttachmentLink>(sql`
    select id, file_id as "fileId", target_table as "targetTable", target_id as "targetId"
      from file_attachments
     where id = ${attachmentId} and org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}
