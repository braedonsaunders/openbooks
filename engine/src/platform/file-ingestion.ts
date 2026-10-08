import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SqlExecutor } from './db.ts'
import { activeStorageKind, putS3Blob } from './file-storage.ts'
import { deriveExtension, deriveFileType } from './file-names.ts'
import { recordFileEvent } from './file-audit.ts'

export type FileMeta = {
  id: string
  folderId: string
  name: string
  extension: string | null
  fileType: string
  contentType: string
  sizeBytes: number
  isInactive: boolean
  currentVersionId: string | null
  versionCount: number
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
  folderName: string | null
};

/**
 * Create a file in the cabinet: file row + initial version + blob. All in one
 * transaction. Returns the new file metadata.
 */
export async function createCabinetFile(input: {
  orgId: string
  folderId: string
  filename: string
  contentType: string
  bytes: Buffer
  createdBy: string | null
  executor: SqlExecutor
  auditActorId?: string | null
  authorizeFolder?: (tx: SqlExecutor) => Promise<void>
  onStagedS3?: (staged: { versionId: string; fileId: string }) => void
}): Promise<FileMeta> {
  const extension = deriveExtension(input.filename)
  const fileType = deriveFileType(input.contentType)
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  const kind = activeStorageKind()
  // The S3 put below cannot roll back with the row transaction. Track the
  // staged version so a later failure (or a commit failure) records a
  // durable cleanup intent instead of stranding the object. Nested callers
  // (executor passed) compensate at their outer boundary, where the final
  // commit verdict is known.
  const tx = input.executor
  await input.authorizeFolder?.(tx)
  {
    const fileIns = (await tx.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type,
                         size_bytes, storage_kind, content_hash, created_by, updated_by,
                         created_at, updated_at)
      values (${input.orgId}, ${input.folderId}, ${input.filename}, ${extension}, ${fileType},
              ${input.contentType}, ${input.bytes.length}, ${kind}, ${contentHash}, ${input.createdBy}, ${input.createdBy},
              now(), now())
      returning id
    `))
    const fileId = fileIns.rows[0]?.id
    if (!fileId) throw new Error('Cabinet file did not persist')

    const verIns = (await tx.execute<{ id: string }>(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  content_hash, created_by, created_at)
      values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, ${kind}, ${contentHash}, ${input.createdBy}, now())
      returning id
    `))
    const versionId = verIns.rows[0]?.id
    if (!versionId) throw new Error('Cabinet file version did not persist')

    const updated = await tx.execute(sql`
      update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${input.orgId} returning id
    `)
    if (updated.rows.length !== 1) throw new Error('Cabinet file version pointer did not persist')
    // Object-store put happens inside the transaction window: an upload
    // failure rolls the metadata back (never metadata without bytes), while
    // a later failure is compensated by the transaction owner using the
    // staged object callback below.
    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
    if (kind === 's3') {
      input.onStagedS3?.({ versionId, fileId })
    }
    else {
      const blob = await tx.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes}) returning version_id
      `)
      if (blob.rows.length !== 1) throw new Error('Cabinet file bytes did not persist')
    }

    if (input.auditActorId !== undefined) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.auditActorId,
        table: 'files',
        rowId: fileId,
        action: 'upload',
        changes: {
          before: null,
          after: {
            id: fileId,
            name: input.filename,
            folderId: input.folderId,
            contentType: input.contentType,
            sizeBytes: input.bytes.length,
            currentVersionId: versionId,
          },
        },
        executor: tx,
      })
    }

    const meta = (await tx.execute<FileMeta>(sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
             fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
             fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
             1 as "versionCount",
             fi.created_at as "createdAt", fi.created_by as "createdBy",
             fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
             fo.name as "folderName"
        from files fi left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id where fi.id = ${fileId} and fi.org_id = ${input.orgId}
    `))
    if (!meta.rows[0]) throw new Error('Cabinet file readback was not found')
    return meta.rows[0]
  }
}
