import { sql } from 'drizzle-orm'
import type { SqlExecutor } from './db.ts'
import { ensureRecordFolder } from './record-folders.ts'
import { createCabinetFile } from './file-ingestion.ts'
import { recordFileEvent } from './file-audit.ts'

/** The native file ingestion used by record attachments and connector photos. */
export async function uploadCabinetAttachment(input: {
  orgId: string
  targetTable: string
  targetId: string
  filename: string
  contentType: string
  bytes: Buffer
  createdBy: string | null
  executor: SqlExecutor
  authorizeTarget?: (executor: SqlExecutor) => Promise<void>
  onStagedS3?: (staged: { versionId: string; fileId: string }) => void
}) {
  const tx = input.executor
  await input.authorizeTarget?.(tx)
  const folderId = await ensureRecordFolder(input.orgId, input.targetTable, input.targetId, tx)
  const file = await createCabinetFile({
    ...input, folderId, auditActorId: input.createdBy,
  })
  const link = (await tx.execute<{ id: string }>(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${input.orgId}, ${file.id}, ${input.targetTable}, ${input.targetId}, ${input.createdBy}, now())
    returning id
  `)).rows[0]
  if (!link) throw new Error('Record attachment did not persist')
  await recordFileEvent({
    orgId: input.orgId, actorId: input.createdBy, table: 'file_attachments',
    rowId: link.id, action: 'create', executor: tx,
    changes: { after: { fileId: file.id, targetTable: input.targetTable, targetId: input.targetId } },
  })
  return {
    id: file.id, name: file.name, fileType: file.fileType, contentType: file.contentType,
    sizeBytes: file.sizeBytes, createdAt: file.createdAt, createdBy: input.createdBy,
    attachmentId: link.id,
  }
}
