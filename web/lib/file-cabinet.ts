import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { activeStorageKind, deleteS3Blobs, getS3Blob, putS3Blob } from './file-storage'

/**
 * File Cabinet — cabinet-first document management. Files exist independently
 * in a folder tree; attaching a file to a record is a link, not a container.
 *
 * Every function is org-scoped: the caller passes the authenticated user's
 * orgId and no row outside that org is ever read, written, or deleted.
 *
 * Raw SQL (not Drizzle table objects) is used for the read paths to keep list
 * queries expressive; inserts use the builder where it helps.
 */

// --- types ------------------------------------------------------------------

/**
 * The authenticated caller, for private-folder visibility. Private folders
 * (is_private) — and everything inside them, descendants included — are
 * visible only to their owner and admins (the schema's is_private contract).
 */
export interface FileViewer {
  userId: string
  isAdmin: boolean
}

export interface FolderNode {
  id: string
  name: string
  parentId: string | null
  isSystem: boolean
  systemKind: string | null
  isPrivate: boolean
  isInactive: boolean
  recordTable: string | null
  recordId: string | null
  childCount: number
  fileCount: number
}

export interface FileMeta {
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
}

export interface FileDetail extends FileMeta {
  versions: FileVersion[]
  attachments: FileAttachmentLink[]
}

export interface FileVersion {
  id: string
  versionNumber: number
  sizeBytes: number
  contentType: string
  contentHash: string | null
  createdAt: string
  createdBy: string | null
}

export interface FileAttachmentLink {
  id: string
  targetTable: string
  targetId: string
  createdAt: string
}

// --- helpers ----------------------------------------------------------------

function deriveExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Visibility predicate for private folders: TRUE when the folder identified
 * by `folderIdCol` is not a private folder owned by someone else, nor a
 * descendant of one. Admins bypass (see FileViewer).
 */
function visibleFolderPredicate(orgId: string, viewer: FileViewer, folderIdCol: SQL): SQL {
  if (viewer.isAdmin) return sql`true`
  return sql`not exists (
    with recursive hidden_folders as (
      select id from folders
       where org_id = ${orgId} and is_private and owner_id is distinct from ${viewer.userId}
      union
      select f.id from folders f
        join hidden_folders h on f.parent_folder_id = h.id
       where f.org_id = ${orgId}
    )
    select 1 from hidden_folders h where h.id = ${folderIdCol}
  )`
}

function deriveFileType(contentType: string): string {
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType === 'text/csv') return 'csv'
  if (contentType.includes('spreadsheet')) return 'spreadsheet'
  if (contentType.includes('wordprocessing')) return 'document'
  if (contentType.startsWith('text/')) return 'text'
  return 'other'
}

// --- system folders ----------------------------------------------------------

/**
 * Ensure the org has its system "Attachments" root folder. Auto-created on
 * first use. Returns the folder id.
 */
export async function ensureAttachmentsRoot(orgId: string): Promise<string> {
  const existing = (await db.execute(sql`
    select id from folders
     where org_id = ${orgId} and system_kind = 'attachments'
  `)) as unknown as { rows: { id: string }[] }
  if (existing.rows.length > 0) return existing.rows[0].id
  const ins = (await db.execute(sql`
    insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
    values (${orgId}, 'Attachments', true, 'attachments', now(), now())
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return ins.rows[0].id
}

/**
 * Ensure a per-record attachment folder exists (auto-created under the
 * "Attachments" system root). One folder per (org, recordTable, recordId).
 * Returns the folder id.
 */
export async function ensureRecordFolder(
  orgId: string,
  recordTable: string,
  recordId: string,
): Promise<string> {
  const existing = (await db.execute(sql`
    select id from folders
     where org_id = ${orgId} and record_table = ${recordTable} and record_id = ${recordId}
  `)) as unknown as { rows: { id: string }[] }
  if (existing.rows.length > 0) return existing.rows[0].id
  const rootId = await ensureAttachmentsRoot(orgId)
  const name = `${recordTable} / ${recordId.slice(0, 8)}`
  const ins = (await db.execute(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${rootId}, ${name}, true, ${recordTable}, ${recordId}, now(), now())
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return ins.rows[0].id
}

// --- folder CRUD ------------------------------------------------------------

/** Fetch the full folder tree for an org (flat list with counts). */
export async function getFolderTree(orgId: string, viewer: FileViewer): Promise<FolderNode[]> {
  const r = (await db.execute(sql`
    select f.id, f.name, f.parent_folder_id as "parentId", f.is_system as "isSystem",
           f.system_kind as "systemKind", f.is_private as "isPrivate",
           f.is_inactive as "isInactive", f.record_table as "recordTable",
           f.record_id as "recordId",
           (select count(*) from folders c where c.parent_folder_id = f.id) as "childCount",
           (select count(*) from files fi where fi.folder_id = f.id and not fi.is_inactive) as "fileCount"
      from folders f
     where f.org_id = ${orgId} and not f.is_inactive
       and ${visibleFolderPredicate(orgId, viewer, sql`f.id`)}
     order by f.is_system desc, f.name asc
  `)) as unknown as { rows: FolderNode[] }
  return r.rows
}

export async function getFolder(
  orgId: string,
  id: string,
): Promise<(FolderNode & { ownerId: string | null }) | null> {
  const r = (await db.execute(sql`
    select f.id, f.name, f.parent_folder_id as "parentId", f.is_system as "isSystem",
           f.system_kind as "systemKind", f.is_private as "isPrivate",
           f.is_inactive as "isInactive", f.record_table as "recordTable",
           f.record_id as "recordId", f.owner_id as "ownerId",
           (select count(*) from folders c where c.parent_folder_id = f.id) as "childCount",
           (select count(*) from files fi where fi.folder_id = f.id and not fi.is_inactive) as "fileCount"
      from folders f
     where f.id = ${id} and f.org_id = ${orgId}
  `)) as unknown as { rows: any[] }
  return r.rows[0] ?? null
}

export async function createFolder(input: {
  orgId: string
  parentId: string | null
  name: string
  isPrivate?: boolean
  ownerId?: string
  createdBy: string
}): Promise<string> {
  const ins = (await db.execute(sql`
    insert into folders (org_id, parent_folder_id, name, is_private, owner_id,
                         created_by, updated_by, created_at, updated_at)
    values (${input.orgId}, ${input.parentId}, ${input.name},
            ${input.isPrivate ?? false}, ${input.ownerId ?? null},
            ${input.createdBy}, ${input.createdBy}, now(), now())
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return ins.rows[0].id
}

export async function renameFolder(
  orgId: string,
  id: string,
  name: string,
  updatedBy: string,
): Promise<boolean> {
  const r = (await db.execute(sql`
    update folders set name = ${name}, updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

export async function moveFolder(
  orgId: string,
  id: string,
  parentId: string | null,
  updatedBy: string,
): Promise<boolean> {
  // Prevent moving into self or descendant
  if (parentId === id) return false
  if (parentId) {
    // The new parent must exist inside this org (blocks cross-org reparenting).
    const parent = (await db.execute(sql`
      select 1 from folders where id = ${parentId} and org_id = ${orgId}
    `)) as unknown as { rows: any[] }
    if (parent.rows.length === 0) return false
    const cycle = (await db.execute(sql`
      with recursive ancestors as (
        select parent_folder_id from folders where id = ${parentId} and org_id = ${orgId}
        union
        select f.parent_folder_id from folders f
        join ancestors a on f.id = a.parent_folder_id and f.org_id = ${orgId}
        where f.parent_folder_id is not null
      )
      select 1 from ancestors where parent_folder_id = ${id} limit 1
    `)) as unknown as { rows: any[] }
    if (cycle.rows.length > 0) return false
  }
  const r = (await db.execute(sql`
    update folders set parent_folder_id = ${parentId}, updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

export async function updateFolder(
  orgId: string,
  id: string,
  patch: { name?: string; isPrivate?: boolean; isInactive?: boolean },
  updatedBy: string,
): Promise<boolean> {
  const setParts: ReturnType<typeof sql.raw>[] = [
    sql`updated_by = ${updatedBy}`,
    sql`updated_at = now()`,
  ]
  if (patch.name !== undefined) setParts.push(sql`name = ${patch.name}`)
  if (patch.isPrivate !== undefined) {
    setParts.push(sql`is_private = ${patch.isPrivate}`)
    // A private folder needs an owner (it is visible only to owner + admins);
    // default to the user flipping the flag.
    if (patch.isPrivate) setParts.push(sql`owner_id = coalesce(owner_id, ${updatedBy})`)
  }
  if (patch.isInactive !== undefined) setParts.push(sql`is_inactive = ${patch.isInactive}`)
  const r = (await db.execute(sql`
    update folders set ${sql.join(setParts, sql`, `)}
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

/**
 * Delete a folder. Fails if it contains files that are attached to records
 * (matching NetSuite behavior). System folders cannot be deleted.
 */
export async function deleteFolder(orgId: string, id: string): Promise<{ ok: boolean; reason?: string }> {
  const folder = await getFolder(orgId, id)
  if (!folder) return { ok: false, reason: 'not found' }
  if (folder.isSystem) return { ok: false, reason: 'system' }

  // Check for attached files in this folder (or descendants)
  const attached = (await db.execute(sql`
    with recursive descendants as (
      select id from folders where id = ${id} and org_id = ${orgId}
      union
      select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
    )
    select 1
      from file_attachments fa
      join files fi on fi.id = fa.file_id
      join descendants d on d.id = fi.folder_id
     where fa.org_id = ${orgId}
     limit 1
  `)) as unknown as { rows: any[] }
  if (attached.rows.length > 0) return { ok: false, reason: 'has attached files' }

  // Delete files (with their versions, blobs, and attachment links) and the
  // folder subtree in one transaction. Versions/blobs/links are removed
  // explicitly so nothing is orphaned even without ON DELETE CASCADE FKs.
  const s3VersionIds = await db.transaction(async (tx) => {
    const descendants = sql`
      with recursive descendants as (
        select id from folders where id = ${id} and org_id = ${orgId}
        union
        select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
      )
      select id from descendants`
    const s3Versions = (await tx.execute(sql`
      select fv.id from file_versions fv
      join files fi on fi.id = fv.file_id
      where fi.folder_id in (${descendants}) and fv.storage_kind = 's3'
    `)) as unknown as { rows: { id: string }[] }
    await tx.execute(sql`
      delete from file_blobs where version_id in (
        select fv.id from file_versions fv
        join files fi on fi.id = fv.file_id
        where fi.folder_id in (${descendants})
      )
    `)
    await tx.execute(sql`
      update files set current_version_id = null where folder_id in (${descendants})
    `)
    await tx.execute(sql`
      delete from file_versions where file_id in (
        select fi.id from files fi where fi.folder_id in (${descendants})
      )
    `)
    await tx.execute(sql`
      delete from file_attachments where file_id in (
        select fi.id from files fi where fi.folder_id in (${descendants})
      )
    `)
    await tx.execute(sql`delete from files where folder_id in (${descendants})`)
    await tx.execute(sql`delete from folders where id in (${descendants})`)
    return s3Versions.rows.map((v) => v.id)
  })
  await deleteS3Blobs(s3VersionIds)
  return { ok: true }
}

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

  const whereParts = [
    sql`fi.org_id = ${orgId}`,
    sql`not fi.is_inactive`,
    visibleFolderPredicate(orgId, viewer, sql`fi.folder_id`),
  ]
  if (opts.folderId) whereParts.push(sql`fi.folder_id = ${opts.folderId}`)
  if (opts.q) whereParts.push(sql`fi.name ilike ${'%' + opts.q + '%'}`)
  const where = sql.join(whereParts, sql` and `)

  const [rows, count] = await Promise.all([
    db.execute(sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
             fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
             fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
             (select count(*) from file_versions fv where fv.file_id = fi.id) as "versionCount",
             fi.created_at as "createdAt", fi.created_by as "createdBy",
             fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
             fo.name as "folderName"
        from files fi
        left join folders fo on fo.id = fi.folder_id
       where ${where}
       order by ${sortColumn} ${dir} nulls last
       limit ${opts.limit ?? 50} offset ${opts.offset ?? 0}
    `),
    db.execute(sql`select count(*) as n from files fi where ${where}`),
  ])
  const files = (rows as any).rows as FileMeta[]
  const total = Number((count as any).rows[0]?.n ?? 0)
  return { files, total }
}

export async function getFile(orgId: string, id: string, viewer: FileViewer): Promise<FileDetail | null> {
  const meta = (await db.execute(sql`
    select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
           fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
           fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
           fi.created_at as "createdAt", fi.created_by as "createdBy",
           fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
           fo.name as "folderName"
      from files fi
      left join folders fo on fo.id = fi.folder_id
     where fi.id = ${id} and fi.org_id = ${orgId}
       and ${visibleFolderPredicate(orgId, viewer, sql`fi.folder_id`)}
  `)) as unknown as { rows: any[] }
  if (meta.rows.length === 0) return null
  const f = meta.rows[0]

  const [versions, attachments] = await Promise.all([
    db.execute(sql`
      select id, version_number as "versionNumber", size_bytes as "sizeBytes",
             content_type as "contentType", content_hash as "contentHash",
             created_at as "createdAt", created_by as "createdBy"
        from file_versions where file_id = ${id} order by version_number desc
    `),
    db.execute(sql`
      select id, target_table as "targetTable", target_id as "targetId",
             created_at as "createdAt"
        from file_attachments where file_id = ${id} and org_id = ${orgId}
        order by created_at desc
    `),
  ])
  const versionCount = (versions as any).rows.length
  return {
    ...f,
    versionCount,
    versions: (versions as any).rows as FileVersion[],
    attachments: (attachments as any).rows as FileAttachmentLink[],
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
  createdBy: string
}): Promise<FileMeta> {
  const extension = deriveExtension(input.filename)
  const fileType = deriveFileType(input.contentType)
  const kind = activeStorageKind()
  return db.transaction(async (tx) => {
    const fileIns = (await tx.execute(sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type,
                         size_bytes, storage_kind, created_by, updated_by,
                         created_at, updated_at)
      values (${input.orgId}, ${input.folderId}, ${input.filename}, ${extension}, ${fileType},
              ${input.contentType}, ${input.bytes.length}, ${kind}, ${input.createdBy}, ${input.createdBy},
              now(), now())
      returning id
    `)) as unknown as { rows: { id: string }[] }
    const fileId = fileIns.rows[0].id

    const verIns = (await tx.execute(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  created_by, created_at)
      values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, ${kind}, ${input.createdBy}, now())
      returning id
    `)) as unknown as { rows: { id: string }[] }
    const versionId = verIns.rows[0].id

    await tx.execute(sql`
      update files set current_version_id = ${versionId} where id = ${fileId}
    `)
    // Object-store put happens inside the transaction: an upload failure rolls
    // the metadata back; a commit failure at worst orphans one unreferenced
    // object (never metadata without bytes).
    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
    else
      await tx.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes})
      `)

    const meta = (await tx.execute(sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
             fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
             fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
             1 as "versionCount",
             fi.created_at as "createdAt", fi.created_by as "createdBy",
             fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
             fo.name as "folderName"
        from files fi left join folders fo on fo.id = fi.folder_id where fi.id = ${fileId}
    `)) as unknown as { rows: FileMeta[] }
    return meta.rows[0]
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
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = (await tx.execute(sql`
      select current_version_id as vid, (
        select max(version_number) from file_versions where file_id = ${input.fileId}
      ) as max_ver
        from files where id = ${input.fileId} and org_id = ${input.orgId}
    `)) as unknown as { rows: { vid: string | null; max_ver: number | null }[] }
    if (current.rows.length === 0) return false
    const nextVer = (current.rows[0].max_ver ?? 0) + 1
    const kind = activeStorageKind()

    const verIns = (await tx.execute(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  created_by, created_at)
      values (${input.fileId}, ${nextVer}, ${input.bytes.length}, ${input.contentType}, ${kind},
              ${input.updatedBy}, now())
      returning id
    `)) as unknown as { rows: { id: string }[] }
    const versionId = verIns.rows[0].id

    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
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
                       updated_by = ${input.updatedBy}, updated_at = now()
       where id = ${input.fileId} and org_id = ${input.orgId}
    `)
    return true
  })
}

export async function renameFile(
  orgId: string,
  id: string,
  name: string,
  updatedBy: string,
): Promise<boolean> {
  const r = (await db.execute(sql`
    update files set name = ${name}, extension = ${deriveExtension(name)},
                     updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId}
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

export async function moveFile(
  orgId: string,
  id: string,
  folderId: string,
  updatedBy: string,
): Promise<boolean> {
  // Destination folder must exist inside this org (blocks cross-org moves).
  const r = (await db.execute(sql`
    update files set folder_id = ${folderId}, updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId}
       and exists (select 1 from folders fo where fo.id = ${folderId} and fo.org_id = ${orgId})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

/**
 * Delete a file with its versions, blobs, and attachment links. Explicit
 * deletes (not FK cascades) so nothing is orphaned even without
 * ON DELETE CASCADE constraints.
 */
export async function deleteFile(orgId: string, id: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const owned = (await tx.execute(sql`
      select id from files where id = ${id} and org_id = ${orgId}
    `)) as unknown as { rows: { id: string }[] }
    if (owned.rows.length === 0) return null
    const s3Versions = (await tx.execute(sql`
      select id from file_versions where file_id = ${id} and storage_kind = 's3'
    `)) as unknown as { rows: { id: string }[] }
    await tx.execute(sql`
      delete from file_blobs where version_id in (select id from file_versions where file_id = ${id})
    `)
    await tx.execute(sql`delete from file_attachments where file_id = ${id}`)
    await tx.execute(sql`update files set current_version_id = null where id = ${id}`)
    await tx.execute(sql`delete from file_versions where file_id = ${id}`)
    await tx.execute(sql`delete from files where id = ${id} and org_id = ${orgId}`)
    return s3Versions.rows.map((v) => v.id)
  })
  if (deleted === null) return false
  await deleteS3Blobs(deleted)
  return true
}

/** Fetch bytes for download (current version). Org-scoped. Reads dispatch on
 *  the version's storage_kind so mixed db/s3 histories keep working. */
export async function getFileBlob(
  orgId: string,
  id: string,
  viewer: FileViewer,
  versionId?: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
  const r = (await db.execute(sql`
    select fi.name, fv.content_type as "contentType", fv.id as "versionId",
           fv.storage_kind as "storageKind", fb.bytes
      from files fi
      join file_versions fv
        on fv.file_id = fi.id
       and fv.id = coalesce(${versionId ?? null}, fi.current_version_id)
      left join file_blobs fb on fb.version_id = fv.id
     where fi.id = ${id} and fi.org_id = ${orgId}
       and ${visibleFolderPredicate(orgId, viewer, sql`fi.folder_id`)}
  `)) as unknown as {
    rows: { name: string; contentType: string; versionId: string; storageKind: string; bytes: Buffer | null }[]
  }
  if (r.rows.length === 0) return null
  const row = r.rows[0]
  const bytes = row.storageKind === 's3' ? await getS3Blob(row.versionId) : row.bytes
  if (!bytes) return null
  return { filename: row.name, contentType: row.contentType, bytes }
}

// --- file attachments (links to records) ------------------------------------

export interface AttachedFile {
  id: string
  name: string
  fileType: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
  attachmentId: string
}

/** List files attached to a record (metadata only, no bytes). */
export async function listAttachments(
  orgId: string,
  targetTable: string,
  targetId: string,
): Promise<AttachedFile[]> {
  const r = (await db.execute(sql`
    select fi.id, fi.name, fi.file_type as "fileType", fi.content_type as "contentType",
           fi.size_bytes as "sizeBytes", fa.created_at as "createdAt",
           fa.created_by as "createdBy", fa.id as "attachmentId"
      from file_attachments fa
      join files fi on fi.id = fa.file_id
     where fa.org_id = ${orgId} and fa.target_table = ${targetTable} and fa.target_id = ${targetId}
     order by fa.created_at desc
  `)) as unknown as { rows: AttachedFile[] }
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
  createdBy: string
}): Promise<AttachedFile> {
  const folderId = await ensureRecordFolder(input.orgId, input.targetTable, input.targetId)
  // NOTE: createFile runs its own transaction on the shared pool, so it must
  // not be nested inside another db.transaction here (a nested transaction
  // would check out a second connection and can exhaust the pool).
  const file = await createFile({
    orgId: input.orgId,
    folderId,
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    createdBy: input.createdBy,
  })
  const attIns = (await db.execute(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${input.orgId}, ${file.id}, ${input.targetTable}, ${input.targetId},
            ${input.createdBy}, now())
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return {
    id: file.id,
    name: file.name,
    fileType: file.fileType,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
    createdBy: input.createdBy,
    attachmentId: attIns.rows[0].id,
  }
}

/** Attach an existing file to a record (no upload). Idempotent. */
export async function attachExisting(input: {
  orgId: string
  fileId: string
  targetTable: string
  targetId: string
  createdBy: string
}): Promise<string | null> {
  const r = (await db.execute(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${input.orgId}, ${input.fileId}, ${input.targetTable}, ${input.targetId},
            ${input.createdBy}, now())
    on conflict (org_id, file_id, target_table, target_id) do nothing
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows[0]?.id ?? null
}

/** Detach a file from a record (does NOT delete the file). */
export async function detachAttachment(orgId: string, attachmentId: string): Promise<boolean> {
  const r = (await db.execute(sql`
    delete from file_attachments where id = ${attachmentId} and org_id = ${orgId} returning id
  `)) as unknown as { rows: { id: string }[] }
  return r.rows.length > 0
}

/** Get the target table for an attachment link (for permission gating). */
export async function getAttachmentTarget(
  orgId: string,
  attachmentId: string,
): Promise<string | null> {
  const r = (await db.execute(sql`
    select target_table from file_attachments where id = ${attachmentId} and org_id = ${orgId}
  `)) as unknown as { rows: { target_table: string }[] }
  return r.rows[0]?.target_table ?? null
}
