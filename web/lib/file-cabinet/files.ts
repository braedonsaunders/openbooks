/** Split from web/lib/file-cabinet.ts; moved without behavior changes. */
import 'server-only'
import { enqueueCabinetCleanup, deriveFileType } from './shared'
import { type FileViewer, type FolderNode, type FileMeta, type FileDetail, type FileVersion, type FileAttachmentLink } from './types'
import { deriveExtension, resolveReadScope, visibleFolderPredicate, visibleFilePredicate, recordTargetVisiblePredicate, recordScopeFilePredicate, liveFilePredicate, visibleFileRowPredicate, recordScopeFolderPredicate } from './visibility'
import { type FileMutationAudit, viewerFileGate, viewerFolderGate, lockCabinetAuthorization, runMutation } from './mutation'
import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db, inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { activeStorageKind, deleteS3Blobs, enqueueStorageCleanupStandalone, fileCabinetObjectKey, getS3Blob, putS3Blob, refuseMaskedStorageKind } from '../file-storage'
import { recordFileEvent } from '../file-audit'

// --- file CRUD --------------------------------------------------------------

export interface ListFilesOptions {
  folderId?: string
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export async function listFiles(
  orgId: string,
  viewer: FileViewer,
  opts: ListFilesOptions = {},
): Promise<{ files: FileMeta[]; total: number }> {
  const sortColumn =
    opts.sort === 'size'
      ? sql`fi.size_bytes`
      : opts.sort === 'created'
        ? sql`fi.created_at`
        : sql`fi.name`
  const dir = opts.dir === 'asc' ? sql`asc` : sql`desc`

  const scope = await resolveReadScope(orgId, viewer)
  const whereParts = [visibleFileRowPredicate(orgId, viewer, scope)]
  if (opts.folderId) whereParts.push(sql`fi.folder_id = ${opts.folderId}`)
  if (opts.q) whereParts.push(sql`fi.name ilike ${'%' + opts.q + '%'}`)
  const where = sql.join(whereParts, sql` and `)

  const [rows, count] = await Promise.all([
    db.execute(sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
             fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
             fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
             coalesce(vc.n, 0) as "versionCount",
             fi.created_at as "createdAt", fi.created_by as "createdBy",
             fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
             fo.name as "folderName"
        from files fi
        left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
        left join lateral (
          select count(*)::int as n
            from file_versions fv
            join files fx on fx.id = fv.file_id and fx.org_id = ${orgId}
           where fv.file_id = fi.id
        ) vc on true
       where ${where}
       order by ${sortColumn} ${dir} nulls last
       limit ${opts.limit ?? 50} offset ${opts.offset ?? 0}
    `),
    db.execute(sql`select count(*) as n from files fi left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id where ${where}`),
  ])
  const files = (rows).rows as FileMeta[]
  const total = Number((count).rows[0]?.n ?? 0)
  return { files, total }
}

/**
 * The contents of one folder for the main pane — a real file browser: the
 * folder's immediate sub-folders followed by its files, in a single paginated
 * window (folders first, then files). At the virtual root (parentId null) only
 * root folders are shown; files never live at the virtual root. Searching (q)
 * bypasses the folder level entirely and returns matching files from the whole
 * cabinet (recursive), matching the old "search spans everything" behaviour.
 *
 * Combined pagination: the page window [offset, offset+limit) walks a virtual
 * list [ ...folders, ...files ]. This keeps one Pagination control for a mixed
 * folder/file listing without loading either side in full.
 */
export interface FolderContents {
  folders: FolderNode[]
  files: FileMeta[]
  folderTotal: number
  fileTotal: number
  total: number
}

export async function listFolderContents(
  orgId: string,
  viewer: FileViewer,
  opts: {
    parentId?: string
    q?: string
    sort?: string
    dir?: 'asc' | 'desc'
    limit?: number
    offset?: number
  } = {},
): Promise<FolderContents> {
  const limit = opts.limit ?? 50
  const offset = opts.offset ?? 0

  // Search spans the whole cabinet — no folder rows, just matching files.
  if (opts.q) {
    const { files, total } = await listFiles(orgId, viewer, {
      q: opts.q,
      sort: opts.sort,
      dir: opts.dir,
      limit,
      offset,
    })
    return { folders: [], files, folderTotal: 0, fileTotal: total, total }
  }

  const scope = await resolveReadScope(orgId, viewer)
  const parentPred = opts.parentId
    ? sql`f.parent_folder_id = ${opts.parentId}`
    : sql`f.parent_folder_id is null`
  // Folder rows carry the same scoping as the tree: hidden ancestors never
  // leak through parentId, and childCount stays within the viewer's scope.
  const rowParentVisible = sql`${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)}
    and ${recordScopeFolderPredicate(orgId, viewer, sql`f.parent_folder_id`)}`
  const childVisible = sql`${visibleFolderPredicate(scope.hiddenFolderIds, sql`c.id`)}
    and ${recordScopeFolderPredicate(orgId, viewer, sql`c.id`)}`
  const fileVisible = visibleFileRowPredicate(orgId, viewer, scope)

  // Folder count first — it anchors the combined pagination math.
  const folderCount = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from folders f
     where f.org_id = ${orgId} and not f.is_inactive and ${parentPred}
       and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
       and ${recordScopeFolderPredicate(orgId, viewer, sql`f.id`)}
  `))
  const folderTotal = folderCount.rows[0]?.n ?? 0

  const folders =
    offset < folderTotal
      ? ((await db.execute<FolderNode>(sql`
          select f.id, f.name,
                 case when ${rowParentVisible} then f.parent_folder_id end as "parentId",
                 f.is_system as "isSystem",
                 f.system_kind as "systemKind", f.is_private as "isPrivate",
                 f.is_inactive as "isInactive", f.record_table as "recordTable",
                 f.record_id as "recordId",
                 (select count(*)::int from folders c
                   where c.parent_folder_id = f.id and c.org_id = ${orgId} and not c.is_inactive
                     and ${childVisible}) as "childCount",
                 (select count(*)::int from files fi
                   left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
                   where fi.folder_id = f.id and ${fileVisible}) as "fileCount"
            from folders f
           where f.org_id = ${orgId} and not f.is_inactive and ${parentPred}
             and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
             and ${recordScopeFolderPredicate(orgId, viewer, sql`f.id`)}
           order by f.is_system desc, f.name asc
           limit ${limit} offset ${offset}
        `))).rows
      : []

  // Files live in a real folder only; the virtual root shows folders alone.
  let files: FileMeta[] = []
  let fileTotal = 0
  if (opts.parentId) {
    const filesReturnable = limit - folders.length
    const filesOffset = Math.max(0, offset - folderTotal)
    const { files: rows, total } = await listFiles(orgId, viewer, {
      folderId: opts.parentId,
      sort: opts.sort,
      dir: opts.dir,
      limit: Math.max(filesReturnable, 0),
      offset: filesOffset,
    })
    fileTotal = total
    files = filesReturnable > 0 ? rows : []
  }

  return { folders, files, folderTotal, fileTotal, total: folderTotal + fileTotal }
}

export async function getFile(orgId: string, id: string, viewer: FileViewer): Promise<FileDetail | null> {
  const scope = await resolveReadScope(orgId, viewer)
  const attachmentTargetVisible = recordTargetVisiblePredicate(
    orgId,
    viewer.allowedSubsidiaryIds,
    sql`fa.target_table`,
    sql`fa.target_id`,
  )
  const meta = (await db.execute(sql`
    select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
           fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
           fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
           fi.created_at as "createdAt", fi.created_by as "createdBy",
           fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
           fo.name as "folderName",
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', fa.id, 'targetTable', fa.target_table, 'targetId', fa.target_id,
               'createdAt', fa.created_at
             ) order by fa.created_at desc)
               from file_attachments fa
              where fa.file_id = fi.id and fa.org_id = fi.org_id
                and ${attachmentTargetVisible ?? sql`true`}
           ), '[]'::jsonb) as attachments
      from files fi
      left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
     where fi.id = ${id} and ${liveFilePredicate(orgId)}
       and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
       and ${recordScopeFilePredicate(orgId, viewer.allowedSubsidiaryIds, sql`fi.id`, sql`fo.record_table`, sql`fo.record_id`)}
  `))
  const f = meta.rows[0]
  if (!f) return null

  const versions = await db.execute(sql`
      select fv.id, fv.version_number as "versionNumber", fv.size_bytes as "sizeBytes",
             fv.content_type as "contentType", fv.content_hash as "contentHash",
             fv.created_at as "createdAt", fv.created_by as "createdBy"
        from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
       where fv.file_id = ${id}
       order by fv.version_number desc
    `)
  const versionCount = versions.rows.length
  return {
    ...f,
    versionCount,
    versions: versions.rows as unknown as FileVersion[],
    attachments: f.attachments as FileAttachmentLink[],
  } as FileDetail
}

/**
 * Create a file in the cabinet: file row + initial version + blob. All in one
 * transaction. Returns the new file metadata.
 */
export async function createFile(input: {
  orgId: string
  folderId: string
  filename: string
  contentType: string
  bytes: Buffer
  createdBy: string | null
  audit?: FileMutationAudit
}): Promise<FileMeta> {
  const extension = deriveExtension(input.filename)
  const fileType = deriveFileType(input.contentType)
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  const kind = activeStorageKind()
  // I5-platform-41: the S3 put below cannot roll back with the row
  // transaction. Track the staged version so a later failure (or a commit
  // failure) records a durable cleanup intent instead of stranding the
  // object. Nested callers (executor passed) compensate at their outer
  // boundary, where the final commit verdict is known.
  let staged: { versionId: string; fileId: string } | null = null
  return runMutation(input.audit?.executor, async (tx) => {
    if (!(await viewerFolderGate(tx, input.orgId, input.audit, input.folderId, 'editor'))) {
      throw new Error('createFile refused: caller lacks editor access to the destination folder')
    }
    const fileIns = (await tx.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type,
                         size_bytes, storage_kind, content_hash, created_by, updated_by,
                         created_at, updated_at)
      values (${input.orgId}, ${input.folderId}, ${input.filename}, ${extension}, ${fileType},
              ${input.contentType}, ${input.bytes.length}, ${kind}, ${contentHash}, ${input.createdBy}, ${input.createdBy},
              now(), now())
      returning id
    `))
    const fileId = fileIns.rows[0]!.id

    const verIns = (await tx.execute<{ id: string }>(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  content_hash, created_by, created_at)
      values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, ${kind}, ${contentHash}, ${input.createdBy}, now())
      returning id
    `))
    const versionId = verIns.rows[0]!.id

    await tx.execute(sql`
      update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${input.orgId}
    `)
    // Object-store put happens inside the transaction window: an upload
    // failure rolls the metadata back (never metadata without bytes), while
    // a later failure is compensated by the catch below, which records a
    // durable cleanup intent for the staged key.
    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
    if (kind === 's3') staged = { versionId, fileId }
    else
      await tx.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes})
      `)

    if (input.audit) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.audit.actorId,
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
    return meta.rows[0]!
  }, input.audit?.viewer ? input.orgId : undefined).catch(async (error) => {
    if (staged && !input.audit?.executor) {
      await enqueueStorageCleanupStandalone({
        orgId: input.orgId,
        objectKey: fileCabinetObjectKey(staged.versionId),
        ownerKind: 'file_version',
        ownerId: staged.fileId,
      })
    }
    throw error
  })
}

/**
 * Replace a file with a new version. Creates a new file_versions row, a new
 * blob, and points current_version_id at it. The old version is preserved.
 */
export async function replaceFile(input: {
  orgId: string
  fileId: string
  filename: string
  contentType: string
  bytes: Buffer
  updatedBy: string
  audit?: FileMutationAudit
}): Promise<boolean> {
  // I5-platform-41: the S3 put below cannot roll back with the row
  // transaction. Track the staged version so the catch below records a
  // durable cleanup intent instead of stranding the object. Nested callers
  // (executor passed) compensate at their outer boundary.
  let staged: { versionId: string; fileId: string } | null = null
  return runMutation(input.audit?.executor, async (tx) => {
    const contentHash = createHash('sha256').update(input.bytes).digest('hex')
    const current = (await tx.execute<{
      vid: string | null
      max_ver: number | null
      name: string
      contentType: string
      sizeBytes: number
    }>(sql`
      select current_version_id as vid, fi.name, fi.content_type as "contentType", fi.size_bytes as "sizeBytes", (
        select max(fv.version_number) from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${input.orgId}
        where fv.file_id = ${input.fileId}
      ) as max_ver
        from files fi where fi.id = ${input.fileId} and fi.org_id = ${input.orgId}
          and not exists (select 1 from ap_capture_items ci where ci.file_id = fi.id and ci.org_id = ${input.orgId})
        for update
    `))
    if (current.rows.length === 0) return false
    if (!(await viewerFileGate(tx, input.orgId, input.audit, input.fileId, 'editor'))) return false
    // Retained evidence keeps its pinned bytes: a new version would fork the
    // cabinet-visible file away from the immutable artifact readers serve.
    const retained = (await tx.execute(sql`
      select 1 from files fi
       where fi.id = ${input.fileId} and fi.org_id = ${input.orgId}
         and ${retainedFileEvidence(input.orgId, sql`fi.id`)}
       limit 1
    `))
    if (retained.rows.length > 0) return false
    const nextVer = (current.rows[0]!.max_ver ?? 0) + 1
    const kind = activeStorageKind()

    const verIns = (await tx.execute<{ id: string }>(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  content_hash, created_by, created_at)
      values (${input.fileId}, ${nextVer}, ${input.bytes.length}, ${input.contentType}, ${kind}, ${contentHash},
              ${input.updatedBy}, now())
      returning id
    `))
    const versionId = verIns.rows[0]!.id

    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
    if (kind === 's3') staged = { versionId, fileId: input.fileId }
    else
      await tx.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes})
      `)
    await tx.execute(sql`
      update files set current_version_id = ${versionId},
                       name = ${input.filename},
                       extension = ${deriveExtension(input.filename)},
                       file_type = ${deriveFileType(input.contentType)},
                       content_type = ${input.contentType},
                       size_bytes = ${input.bytes.length},
                       content_hash = ${contentHash},
                       updated_by = ${input.updatedBy}, updated_at = now()
       where id = ${input.fileId} and org_id = ${input.orgId}
    `)
    if (input.audit) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.audit.actorId,
        table: 'files',
        rowId: input.fileId,
        action: 'replace',
        changes: {
          before: {
            name: current.rows[0]!.name,
            contentType: current.rows[0]!.contentType,
            sizeBytes: current.rows[0]!.sizeBytes,
            currentVersionId: current.rows[0]!.vid,
            versionNumber: current.rows[0]!.max_ver,
          },
          after: {
            name: input.filename,
            contentType: input.contentType,
            sizeBytes: input.bytes.length,
            currentVersionId: versionId,
            versionNumber: nextVer,
          },
        },
        executor: tx,
      })
    }
    return true
  }, input.audit?.viewer ? input.orgId : undefined).catch(async (error) => {
    if (staged && !input.audit?.executor) {
      await enqueueStorageCleanupStandalone({
        orgId: input.orgId,
        objectKey: fileCabinetObjectKey(staged.versionId),
        ownerKind: 'file_version',
        ownerId: staged.fileId,
      })
    }
    throw error
  })
}
export async function renameFile(
  orgId: string,
  id: string,
  name: string,
  updatedBy: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  if (!audit) {
    const r = (await db.execute<{ id: string }>(sql`
      update files set name = ${name}, extension = ${deriveExtension(name)},
                       updated_by = ${updatedBy}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
      returning id
    `))
    return r.rows.length > 0
  }
  return runMutation(audit.executor, async (tx) => {
    const prev = (await tx.execute<{ id: string; name: string }>(sql`
      select id, name from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
      for update
    `))
    if (prev.rows.length === 0) return false
    if (!(await viewerFileGate(tx, orgId, audit, id, 'editor'))) return false
    await tx.execute(sql`
      update files set name = ${name}, extension = ${deriveExtension(name)},
                       updated_by = ${updatedBy}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
    `)
    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'files',
      rowId: id,
      action: 'rename',
      changes: { from: prev.rows[0]!.name, to: name },
      executor: tx,
    })
    return true
  }, audit.viewer ? orgId : undefined)
}

export async function moveFile(
  orgId: string,
  id: string,
  folderId: string,
  updatedBy: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  if (!audit) {
    // Destination folder must exist inside this org (blocks cross-org moves).
    const r = (await db.execute<{ id: string }>(sql`
      update files set folder_id = ${folderId}, updated_by = ${updatedBy}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
         and exists (select 1 from folders fo where fo.id = ${folderId} and fo.org_id = ${orgId})
      returning id
    `))
    return r.rows.length > 0
  }
  return runMutation(audit.executor, async (tx) => {
    const prev = (await tx.execute<{ id: string; folderId: string }>(sql`
      select id, folder_id as "folderId" from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
        and exists (select 1 from folders fo where fo.id = ${folderId} and fo.org_id = ${orgId})
      for update
    `))
    if (prev.rows.length === 0) return false
    if (!(await viewerFileGate(tx, orgId, audit, id, 'editor'))) return false
    if (!(await viewerFolderGate(tx, orgId, audit, folderId, 'editor'))) return false
    await tx.execute(sql`
      update files set folder_id = ${folderId}, updated_by = ${updatedBy}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
    `)
    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'files',
      rowId: id,
      action: 'move',
      changes: {
        before: { folderId: prev.rows[0]!.folderId },
        after: { folderId },
        fromFolderId: prev.rows[0]!.folderId,
        toFolderId: folderId,
      },
      executor: tx,
    })
    return true
  }, audit.viewer ? orgId : undefined)
}

/**
 * Trash a file — soft-delete (is_inactive) so it can be restored. AP-capture
 * evidence files are protected. Attachment links are kept (restore re-shows it).
 */
export async function deleteFile(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  const trash = async (exec: SqlExecutor): Promise<boolean> => {
    const r = (await exec.execute<{ id: string }>(sql`
      update files set is_inactive = true, updated_at = now()
       where id = ${id} and org_id = ${orgId} and not is_inactive
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
         and not ${retainedFileEvidence(orgId, sql`files.id`)}
      returning id
    `))
    return r.rows.length > 0
  }
  if (!audit) return trash(db)
  return runMutation(audit.executor, async (tx) => {
    const before = (await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select id, is_inactive as "isInactive"
        from files
       where id = ${id} and org_id = ${orgId} and not is_inactive
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
       for update
    `)).rows[0]
    if (!before) return false
    if (!(await viewerFileGate(tx, orgId, audit, id, 'manager'))) return false
    if (!(await trash(tx))) return false
    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'files',
      rowId: id,
      action: 'delete',
      changes: {
        permanent: false,
        before: { id, isInactive: before.isInactive },
        after: { id, isInactive: true },
      },
      executor: tx,
    })
    return true
  }, audit.viewer ? orgId : undefined)
}

/** Restore a trashed file and its attributable before/after evidence atomically. */
export async function restoreFile(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  return runMutation(audit?.executor, async (tx) => {
    const before = (await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select id, is_inactive as "isInactive"
        from files
       where id = ${id} and org_id = ${orgId} and is_inactive
       for update
    `)).rows[0]
    if (!before) return false
    if (!(await viewerFileGate(tx, orgId, audit, id, 'manager', { includeInactive: true }))) return false
    await tx.execute(sql`
      update files set is_inactive = false, updated_at = now()
       where id = ${id} and org_id = ${orgId}
    `)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'files',
        rowId: id,
        action: 'restore',
        changes: {
          before: { id, isInactive: before.isInactive },
          after: { id, isInactive: false },
        },
        executor: tx,
      })
    }
    return true
  }, audit?.viewer ? orgId : undefined)
}

/**
 * Redacted durable evidence retained when a purged file's rows disappear:
 * metadata, the version inventory, and attachment links — never blob bytes.
 */
interface PurgedFileEvidence {
  file: { id: string; folderId: string; name: string; contentType: string; sizeBytes: number }
  versions: Array<{
    id: string
    versionNumber: number
    sizeBytes: number
    contentType: string
    contentHash: string | null
  }>
  attachments: Array<{ targetTable: string; targetId: string }>
}

/**
 * Attachment links (aliased `fa`) that are RETAINED evidence: a posted
 * document, a compliance record that is still in force, or a fixed asset.
 * Purge refuses to destroy such a file and detach refuses to unlink it — the
 * two halves of one guarantee, since a detached file becomes purgeable.
 */
/**
 * HRM documents whose file evidence is lifecycle-governed (aliased `d`): any
 * non-terminal document, plus anything under legal hold or carrying a
 * retention clock even if terminal — the retention lifecycle owns deletion
 * (retention.ts deletes only non-deleted/non-voided rows and honors holds).
 */
const HRM_DOCUMENT_RETAINED: SQL = sql`(
  d.status not in ('deleted', 'voided')
  or d.legal_hold
  or d.retain_until is not null
)`

export const RETAINED_ATTACHMENT: SQL = sql`(
  (fa.target_table = 'documents' and exists (
    select 1 from documents d
     where d.id = fa.target_id and d.org_id = fa.org_id and d.status = 'posted'))
  or (fa.target_table = 'compliance_records' and exists (
    select 1 from compliance_records cr
     where cr.id = fa.target_id and cr.org_id = fa.org_id and cr.status <> 'superseded'))
  or (fa.target_table = 'fixed_assets' and exists (
    select 1 from fixed_assets a
     where a.id = fa.target_id and a.org_id = fa.org_id))
  or (fa.target_table = 'hrm_documents' and exists (
    select 1 from hrm_documents d
     where d.id = fa.target_id and d.org_id = fa.org_id and ${HRM_DOCUMENT_RETAINED}))
)`

/**
 * Files that are retained evidence no cabinet verb may hide or destroy:
 * retained attachment links (above), files pinned by a live HRM document,
 * live payment-run artifacts (payment_files rows are immutable; readers fetch
 * the pinned version regardless of files.is_inactive), and proof files of
 * live payment mandates. Callers pass the files-id expression; the fragment
 * reserves the `fa`, `d`, `pf`, and `pm` aliases. Enforced in trash, folder
 * trash, replace, purge, folder purge, and detach — the DSAR and payment
 * readers intentionally keep serving pinned bytes, so hiding the cabinet row
 * must be refused rather than silently diverged.
 */
export function retainedFileEvidence(orgId: string, fileId: SQL): SQL {
  return sql`(
    exists (
      select 1 from file_attachments fa
       where fa.file_id = ${fileId} and fa.org_id = ${orgId} and ${RETAINED_ATTACHMENT})
    or exists (
      select 1 from hrm_documents d
       where d.file_id = ${fileId} and d.org_id = ${orgId} and ${HRM_DOCUMENT_RETAINED})
    or exists (
      select 1 from payment_files pf
       where pf.file_id = ${fileId} and pf.org_id = ${orgId}
         and pf.status not in ('superseded', 'voided', 'rejected'))
    or exists (
      select 1 from payment_mandates pm
       where pm.proof_file_id = ${fileId} and pm.org_id = ${orgId}
         and pm.status not in ('revoked', 'expired'))
  )`
}

/**
 * Message-only retained check for routes: after a boolean verb refuses, this
 * names the 409. Enforcement lives inside the verbs' own transactions; this
 * read only selects the message and may race the mutation's snapshot.
 */
export async function isRetainedFileEvidence(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(sql`
    select 1 from files fi
     where fi.id = ${id} and fi.org_id = ${orgId} and ${retainedFileEvidence(orgId, sql`fi.id`)}
     limit 1
  `))
  return r.rows.length > 0
}

/** Lock the mutable record row whose lifecycle controls evidence retention. */
export async function lockRetainedAttachmentTarget(
  exec: SqlExecutor,
  orgId: string,
  targetTable: string,
  targetId: string,
): Promise<void> {
  if (targetTable === 'documents') {
    await exec.execute(sql`select id from documents where id = ${targetId} and org_id = ${orgId} for update`)
  } else if (targetTable === 'compliance_records') {
    await exec.execute(sql`select id from compliance_records where id = ${targetId} and org_id = ${orgId} for update`)
  } else if (targetTable === 'fixed_assets') {
    await exec.execute(sql`select id from fixed_assets where id = ${targetId} and org_id = ${orgId} for update`)
  }
}

/** Lock every currently linked retention owner before rechecking the predicate. */
async function lockFileAttachmentTargets(exec: SqlExecutor, orgId: string, fileId: string): Promise<void> {
  const targets = (await exec.execute<{ targetTable: string; targetId: string }>(sql`
    select target_table as "targetTable", target_id as "targetId"
      from file_attachments
     where org_id = ${orgId} and file_id = ${fileId}
     order by target_table, target_id
  `)).rows
  for (const target of targets) {
    await lockRetainedAttachmentTarget(exec, orgId, target.targetTable, target.targetId)
  }
}

async function capturePurgeEvidence(
  exec: SqlExecutor,
  orgId: string,
  id: string,
): Promise<PurgedFileEvidence> {
  const meta = (await exec.execute<PurgedFileEvidence['file']>(sql`
    select id, folder_id as "folderId", name, content_type as "contentType", size_bytes as "sizeBytes"
      from files where id = ${id} and org_id = ${orgId}
  `))
  const versions = (await exec.execute<PurgedFileEvidence['versions'][number]>(sql`
    select fv.id, fv.version_number as "versionNumber", fv.size_bytes as "sizeBytes",
           fv.content_type as "contentType", fv.content_hash as "contentHash"
      from file_versions fv
      join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
     where fv.file_id = ${id}
     order by fv.version_number
  `))
  const attachments = (await exec.execute<PurgedFileEvidence['attachments'][number]>(sql`
    select target_table as "targetTable", target_id as "targetId"
      from file_attachments where file_id = ${id} and org_id = ${orgId}
     order by created_at
  `))
  return { file: meta.rows[0]!, versions: versions.rows, attachments: attachments.rows }
}

/**
 * Permanently delete a file with its versions, blobs, and attachment links.
 * Explicit deletes (not FK cascades) so nothing is orphaned.
 *
 * Retention guard (fail closed): a file attached to an immutable/material
 * record — a POSTED document, a compliance record that has not been superseded,
 * or a fixed asset — can never be purged; the transaction refuses before any
 * delete runs, so file, versions, blobs, and links all survive intact.
 * Superseded compliance records do not block: renewal replaces the evidence,
 * so the controlled supersession chain is what carries retention forward.
 *
 * When `audit` is passed, the deletes commit together with durable redacted
 * before-evidence in one transaction: a failed audit insert aborts the purge
 * with every row intact. The S3 blob deletion stays strictly POST-commit —
 * external objects are only removed after metadata, evidence, and all DB
 * link/version/blob/file rows are durably gone — so an audit failure leaves
 * both metadata and external blobs untouched and retryable.
 */
export type PurgeFileOutcome = 'purged' | 'not_found' | 'forbidden' | 'retained'

export async function purgeFile(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<PurgeFileOutcome> {
  const deleted = await inDbTransaction(async (tx) => {
    if (audit?.viewer) await lockCabinetAuthorization(tx, orgId)
    const owned = (await tx.execute<{ id: string }>(sql`
      select id from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
      for update
    `))
    if (owned.rows.length === 0) return { outcome: 'not_found' as const }
    if (!(await viewerFileGate(tx, orgId, audit, id, 'manager'))) return { outcome: 'forbidden' as const }
    await lockFileAttachmentTargets(tx, orgId, id)
    const material = (await tx.execute(sql`
      select fa.id
        from file_attachments fa
       where fa.file_id = ${id} and fa.org_id = ${orgId}
         and ${RETAINED_ATTACHMENT}
       limit 1
    `))
    // Pinned references with no attachment row (payment artifacts, HRM
    // documents, mandate proofs) dangle the same way when bytes are purged.
    const pinned = (await tx.execute(sql`
      select 1 from files fi
       where fi.id = ${id} and fi.org_id = ${orgId} and ${retainedFileEvidence(orgId, sql`fi.id`)}
       limit 1
    `))
    if (material.rows.length > 0 || pinned.rows.length > 0) return { outcome: 'retained' as const }
    const s3Versions = (await tx.execute<{ id: string; file_id: string }>(sql`
      select fv.id, fv.file_id from file_versions fv
      join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
      where fv.file_id = ${id} and fv.storage_kind = 's3'
    `))
    const evidence = audit ? await capturePurgeEvidence(tx, orgId, id) : null
    await tx.execute(sql`
      delete from file_blobs where version_id in (
        select fv.id from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
        where fv.file_id = ${id}
      )
    `)
    await tx.execute(sql`delete from file_attachments where file_id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`update files set current_version_id = null where id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      delete from file_versions fv
      using files fi
      where fv.file_id = fi.id and fi.org_id = ${orgId} and fv.file_id = ${id}
    `)
    await tx.execute(sql`delete from files where id = ${id} and org_id = ${orgId}`)
    await enqueueCabinetCleanup(tx, orgId, s3Versions.rows)
    if (audit && evidence) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'files',
        rowId: id,
        action: 'purge',
        changes: { permanent: true, before: evidence },
        executor: tx,
      })
    }
    return { outcome: 'purged' as const, s3VersionIds: s3Versions.rows.map((v) => v.id) }
  })
  if (deleted.outcome !== 'purged') return deleted.outcome
  await deleteS3Blobs(deleted.s3VersionIds)
  return 'purged'
}

/** Fetch bytes for download (current version). Org-scoped. Reads dispatch on
 *  the version's storage_kind so mixed db/s3 histories keep working. */
export async function getFileBlob(
  orgId: string,
  id: string,
  viewer: FileViewer,
  versionId?: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer; versionId: string } | null> {
  const scope = await resolveReadScope(orgId, viewer)
  const r = (await db.execute<{ name: string; contentType: string; versionId: string; storageKind: string; bytes: Buffer | null }>(sql`
    select fi.name, fv.content_type as "contentType", fv.id as "versionId",
           fv.storage_kind as "storageKind", fb.bytes
      from files fi
      join file_versions fv
        on fv.file_id = fi.id
       and fv.id = coalesce(${versionId ?? null}, fi.current_version_id)
      left join file_blobs fb on fb.version_id = fv.id
      left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
     where fi.id = ${id} and ${liveFilePredicate(orgId)}
       and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
       and ${recordScopeFilePredicate(orgId, viewer.allowedSubsidiaryIds, sql`fi.id`, sql`fo.record_table`, sql`fo.record_id`)}
  `))
  if (r.rows.length === 0) return null
  const row = r.rows[0]!
  // Masked-clone tombstone: refuse by name BEFORE any byte fetch, so a
  // tombstoned row can never fall through to the bytea/S3 branches below.
  refuseMaskedStorageKind(row.storageKind)
  const bytes = row.storageKind === 's3' ? await getS3Blob(row.versionId) : row.bytes
  if (!bytes) return null
  // The resolved version id is an immutable validator: a file_versions row's
  // bytes never change (append-only versioning), so it doubles as a strong ETag.
  return { filename: row.name, contentType: row.contentType, bytes, versionId: row.versionId }
}
