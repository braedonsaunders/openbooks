/** Split from web/lib/file-cabinet.ts; moved without behavior changes. */
import 'server-only'
import { enqueueCabinetCleanup } from './shared'
import { type FileViewer, type FolderNode } from './types'
import { resolveReadScope, visibleFolderPredicate, visibleFileRowPredicate, recordScopeFolderPredicate } from './visibility'
import { retainedFileEvidence } from './files'
import { type FileMutationAudit, viewerFolderGate, lockCabinetAuthorization, runMutation } from './mutation'
import { sql, type SQL } from 'drizzle-orm'
import { db, inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { deleteS3Blobs } from '../file-storage'
import { recordFileEvent } from '../file-audit'

// --- folder CRUD ------------------------------------------------------------

/**
 * Fetch the navigable folder tree for the sidebar (flat list with counts).
 *
 * Excludes per-record leaf folders (record_id is not null) — the auto-created
 * attachment containers, one per attached record, which can number in the tens
 * of thousands. Those are an internal linkage layer ("a link, not a container"),
 * not navigation: they are reached by drilling into their kind group folder in
 * the main pane (see listFolderContents), never enumerated in the sidebar. The
 * tree therefore holds only system roots, kind group folders, and user folders —
 * a small, bounded set regardless of attachment volume.
 *
 * Counts are computed with GROUP BY aggregates (two single passes) rather than
 * correlated subqueries per folder.
 *
 * The same private-folder read scope as everywhere else applies: hidden
 * folders never appear, a parentId behind a foreign private boundary is masked
 * to null (a grant re-opens privacy-hidden content only), and childCount counts
 * only children the viewer could actually open within their subsidiary fence.
 */
export async function getFolderTree(orgId: string, viewer: FileViewer): Promise<FolderNode[]> {
  const scope = await resolveReadScope(orgId, viewer)
  const parentVisible = sql`${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)}
    and ${recordScopeFolderPredicate(orgId, viewer, sql`f.parent_folder_id`)}`
  const r = (await db.execute<FolderNode>(sql`
    select f.id, f.name,
           case when ${parentVisible} then f.parent_folder_id end as "parentId",
           f.is_system as "isSystem",
           f.system_kind as "systemKind", f.is_private as "isPrivate",
           f.is_inactive as "isInactive", f.record_table as "recordTable",
           f.record_id as "recordId",
           coalesce(cc.n, 0) as "childCount",
           coalesce(fc.n, 0) as "fileCount"
      from folders f
      left join (
        select parent_folder_id, count(*)::int as n
          from folders
         where org_id = ${orgId} and not is_inactive
           and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`id`)}
           and ${recordScopeFolderPredicate(orgId, viewer, sql`id`)}
         group by parent_folder_id
      ) cc on cc.parent_folder_id = f.id
      left join (
        select fi.folder_id, count(*)::int as n
          from files fi
          left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
         where ${visibleFileRowPredicate(orgId, viewer, scope)}
         group by fi.folder_id
      ) fc on fc.folder_id = f.id
     where f.org_id = ${orgId} and not f.is_inactive
       and f.record_id is null
       and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
       and ${recordScopeFolderPredicate(orgId, viewer, sql`f.id`)}
     order by f.is_system desc, f.name asc
  `))
  return r.rows
}

/**
 * Ancestor chain (root → … → the folder itself) for a breadcrumb, filtered to
 * the caller's read scope: folders hidden by a foreign private boundary are
 * omitted (a grant re-opens exactly its own subtree), and a chain whose target
 * itself is hidden comes back empty — the same visibility the tree and lists
 * enforce, so breadcrumbs can never reveal hidden names or ids.
 */
export async function getFolderPath(
  orgId: string,
  viewer: FileViewer,
  folderId: string,
): Promise<{ id: string; name: string; systemKind: string | null }[]> {
  const scope = await resolveReadScope(orgId, viewer)
  const visible = visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)
  const recordVisible = recordScopeFolderPredicate(orgId, viewer, sql`f.id`)
  const r = (await db.execute<{ id: string; name: string; systemKind: string | null }>(sql`
    with recursive chain as (
      select id, name, system_kind, parent_folder_id, 0 as depth
        from folders f
       where f.id = ${folderId} and f.org_id = ${orgId} and ${visible} and ${recordVisible}
      union all
      select f.id, f.name, f.system_kind, f.parent_folder_id, c.depth + 1
        from folders f join chain c on f.id = c.parent_folder_id and f.org_id = ${orgId}
       where ${visible} and ${recordVisible}
    )
    select id, name, system_kind as "systemKind" from chain order by depth desc
  `))
  return r.rows
}

/**
 * One folder's metadata. Org-scoped always; when a viewer is passed the same
 * private-folder read scope as the tree/lists applies — a folder hidden behind
 * a foreign private boundary reads as not found, an inaccessible parent id is
 * masked to null instead of leaking the hidden ancestor, and childCount counts
 * only children the viewer could actually open.
 */
export async function getFolder(
  orgId: string,
  id: string,
  viewer?: FileViewer,
): Promise<(FolderNode & { ownerId: string | null }) | null> {
  const scope = viewer ? await resolveReadScope(orgId, viewer) : null
  const selfVisible = scope ? visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`) : sql`true`
  const parentVisible = scope && viewer
    ? sql`${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)}
        and ${recordScopeFolderPredicate(orgId, viewer, sql`f.parent_folder_id`)}`
    : sql`true`
  const childVisible = scope && viewer
    ? sql`${visibleFolderPredicate(scope.hiddenFolderIds, sql`c.id`)}
        and ${recordScopeFolderPredicate(orgId, viewer, sql`c.id`)}`
    : sql`true`
  const recordVisible = viewer
    ? recordScopeFolderPredicate(orgId, viewer, sql`f.id`)
    : sql`true`
  const fileCountVisible = viewer && scope
    ? visibleFileRowPredicate(orgId, viewer, scope)
    : sql`fi.org_id = ${orgId} and not fi.is_inactive`
  const r = (await db.execute<FolderNode & { ownerId: string | null }>(sql`
    select f.id, f.name,
           case when ${parentVisible} then f.parent_folder_id end as "parentId",
           f.is_system as "isSystem",
           f.system_kind as "systemKind", f.is_private as "isPrivate",
           f.is_inactive as "isInactive", f.record_table as "recordTable",
           f.record_id as "recordId", f.owner_id as "ownerId",
           (select count(*)::int from folders c
             where c.parent_folder_id = f.id and c.org_id = ${orgId} and ${childVisible}) as "childCount",
           (select count(*)::int from files fi
             left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
            where fi.folder_id = f.id and ${fileCountVisible}) as "fileCount"
      from folders f
     where f.id = ${id} and f.org_id = ${orgId} and not f.is_inactive and ${selfVisible}
       and ${recordVisible}
  `))
  return r.rows[0] ?? null
}

export async function createFolder(input: {
  orgId: string
  parentId: string | null
  name: string
  isPrivate?: boolean
  ownerId?: string
  createdBy: string
  audit?: FileMutationAudit
}): Promise<string> {
  const work = async (tx: SqlExecutor): Promise<string> => {
    if (input.parentId && !(await viewerFolderGate(tx, input.orgId, input.audit, input.parentId, 'editor'))) {
      throw new Error('createFolder refused: caller lacks editor access to the parent folder')
    }
    const ins = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_private, owner_id,
                           created_by, updated_by, created_at, updated_at)
      values (${input.orgId}, ${input.parentId}, ${input.name},
              ${input.isPrivate ?? false}, ${input.ownerId ?? null},
              ${input.createdBy}, ${input.createdBy}, now(), now())
      returning id
    `))
    const id = ins.rows[0]!.id
    if (input.audit) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'create',
        changes: {
          before: null,
          after: {
            id,
            parentId: input.parentId,
            name: input.name,
            isPrivate: input.isPrivate ?? false,
            ownerId: input.ownerId ?? null,
          },
        },
        executor: tx,
      })
    }
    return id
  }
  return input.audit?.executor ? work(input.audit.executor) : inDbTransaction(work)
}

export async function renameFolder(
  orgId: string,
  id: string,
  name: string,
  updatedBy: string,
): Promise<boolean> {
  const r = (await db.execute<{ id: string }>(sql`
    update folders set name = ${name}, updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `))
  return r.rows.length > 0
}

export async function moveFolder(
  orgId: string,
  id: string,
  parentId: string | null,
  updatedBy: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  const work = async (tx: SqlExecutor): Promise<boolean> => {
    const before = (await tx.execute<{ id: string; parentId: string | null; isSystem: boolean }>(sql`
      select id, parent_folder_id as "parentId", is_system as "isSystem"
        from folders where id = ${id} and org_id = ${orgId} for update
    `)).rows[0]
    if (!before || before.isSystem || parentId === id) return false
    if (!(await viewerFolderGate(tx, orgId, audit, id, 'manager'))) return false
    if (parentId) {
      const parent = (await tx.execute(sql`
        select 1 from folders where id = ${parentId} and org_id = ${orgId}
      `))
      if (parent.rows.length === 0) return false
      if (!(await viewerFolderGate(tx, orgId, audit, parentId, 'editor'))) return false
      const cycle = (await tx.execute(sql`
        with recursive ancestors as (
          select parent_folder_id from folders where id = ${parentId} and org_id = ${orgId}
          union
          select f.parent_folder_id from folders f
          join ancestors a on f.id = a.parent_folder_id and f.org_id = ${orgId}
          where f.parent_folder_id is not null
        )
        select 1 from ancestors where parent_folder_id = ${id} limit 1
      `))
      if (cycle.rows.length > 0) return false
    }
    await tx.execute(sql`
      update folders set parent_folder_id = ${parentId}, updated_by = ${updatedBy}, updated_at = now()
       where id = ${id} and org_id = ${orgId} and not is_system
    `)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'move',
        changes: { before: { parentId: before.parentId }, after: { parentId } },
        executor: tx,
      })
    }
    return true
  }
  return audit ? runMutation(audit.executor, work, audit.viewer ? orgId : undefined) : inDbTransaction(work)
}

export async function updateFolder(
  orgId: string,
  id: string,
  patch: { name?: string; isPrivate?: boolean },
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
  const r = (await db.execute<{ id: string }>(sql`
    update folders set ${sql.join(setParts, sql`, `)}
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `))
  return r.rows.length > 0
}

export type FolderPatch = {
  parentId?: string | null
  name?: string
  isPrivate?: boolean
}

export type FolderPatchResult = { ok: true } | { ok: false; reason: 'not found' | 'forbidden' | 'cannot move folder' | 'cannot rename system folder' | 'cannot update system folder' }

/**
 * Apply every requested folder edit and its activity evidence in one
 * transaction. Validation happens against a locked target before any write,
 * so a later failure (for example, attempting to rename a system folder) can
 * never leave an earlier move or flag change committed.
 */
export async function patchFolder(
  orgId: string,
  id: string,
  patch: FolderPatch,
  updatedBy: string,
  audit: FileMutationAudit,
): Promise<FolderPatchResult> {
  let hasParent = Object.prototype.hasOwnProperty.call(patch, 'parentId')
  const hasName = patch.name !== undefined
  const hasFlags = patch.isPrivate !== undefined
  return runMutation(audit.executor, async (tx) => {
    const before = (await tx.execute<{
      id: string
      name: string
      parentId: string | null
      isPrivate: boolean
      isSystem: boolean
    }>(sql`
      select id, name, parent_folder_id as "parentId", is_private as "isPrivate",
             is_system as "isSystem"
        from folders
       where id = ${id} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!before) return { ok: false as const, reason: 'not found' as const }
    // Renames also apply inside the trash: evaluate the tier with inactive rows.
    if (!(await viewerFolderGate(tx, orgId, audit, id, 'manager', { includeInactive: true }))) {
      return { ok: false as const, reason: 'forbidden' as const }
    }

    if (before.isSystem && hasName) {
      return { ok: false as const, reason: 'cannot rename system folder' as const }
    }
    if (before.isSystem && hasParent) {
      return { ok: false as const, reason: 'cannot move folder' as const }
    }
    if (before.isSystem && hasFlags) {
      return { ok: false as const, reason: 'cannot update system folder' as const }
    }

    // A move to the already-stored parent is a rename with a redundant key,
    // not a relocation: skip the destination gates and the move evidence.
    if (hasParent && (patch.parentId ?? null) === before.parentId) hasParent = false
    if (hasParent) {
      const parentId = patch.parentId ?? null
      if (parentId === id) return { ok: false as const, reason: 'cannot move folder' as const }
      if (parentId) {
        const parent = (await tx.execute<{ id: string }>(sql`
          select id from folders where id = ${parentId} and org_id = ${orgId} for share
        `)).rows[0]
        if (!parent) return { ok: false as const, reason: 'cannot move folder' as const }
        if (!(await viewerFolderGate(tx, orgId, audit, parentId, 'editor'))) {
          return { ok: false as const, reason: 'forbidden' as const }
        }
        const cycle = await tx.execute(sql`
          with recursive ancestors as (
            select parent_folder_id from folders where id = ${parentId} and org_id = ${orgId}
            union
            select f.parent_folder_id from folders f
            join ancestors a on f.id = a.parent_folder_id and f.org_id = ${orgId}
            where f.parent_folder_id is not null
          )
          select 1 from ancestors where parent_folder_id = ${id} limit 1
        `)
        if (cycle.rows.length > 0) return { ok: false as const, reason: 'cannot move folder' as const }
      } else if (audit.viewer && !(audit.viewer.isAdmin || audit.viewer.baseline === 'manager')) {
        // Moving to the cabinet root publishes the subtree to every
        // documents.read user: the same bar as creating a top-level folder
        // (documents.manage baseline). A viewer-less audit is a trusted
        // internal caller and keeps the historical allow.
        return { ok: false as const, reason: 'forbidden' as const }
      }
    }

    const updates: ReturnType<typeof sql.raw>[] = [sql`updated_by = ${updatedBy}`, sql`updated_at = now()`]
    if (hasParent) updates.push(sql`parent_folder_id = ${patch.parentId ?? null}`)
    if (hasName) updates.push(sql`name = ${patch.name}`)
    if (patch.isPrivate !== undefined) {
      updates.push(sql`is_private = ${patch.isPrivate}`)
      if (patch.isPrivate) updates.push(sql`owner_id = coalesce(owner_id, ${updatedBy})`)
    }
    if (updates.length > 2) {
      await tx.execute(sql`
        update folders set ${sql.join(updates, sql`, `)}
         where id = ${id} and org_id = ${orgId}
      `)
    }

    if (hasParent) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'move',
        changes: { fromParentId: before.parentId, toParentId: patch.parentId ?? null },
        executor: tx,
      })
    }
    if (hasName) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'rename',
        changes: { from: before.name, to: patch.name },
        executor: tx,
      })
    }
    if (hasFlags) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'update',
        changes: {
          isPrivate: patch.isPrivate ?? before.isPrivate,
        },
        executor: tx,
      })
    }
    return { ok: true as const }
  }, audit.viewer ? orgId : undefined)
}

const FOLDER_DESCENDANTS = (orgId: string, id: string): SQL => sql`
  with recursive descendants as (
    select id from folders where id = ${id} and org_id = ${orgId}
    union
    select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
  )
  select id from descendants`

/**
 * Trash a folder — soft-delete (is_inactive) the folder and everything beneath
 * it (sub-folders + their files) so it can be restored. System folders cannot
 * be trashed. Files kept as AP-capture evidence are left in place.
 */
export async function deleteFolder(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<{ ok: boolean; reason?: string }> {
  const result = await runMutation(audit?.executor, async (tx) => {
    const descendants = FOLDER_DESCENDANTS(orgId, id)
    const folder = (await tx.execute<{ id: string; isSystem: boolean; isInactive: boolean }>(sql`
      select id, is_system as "isSystem", is_inactive as "isInactive"
        from folders
       where id = ${id} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!folder) return { ok: false, reason: 'not found' as const }
    if (folder.isSystem) return { ok: false, reason: 'system' as const }
    if (!(await viewerFolderGate(tx, orgId, audit, id, 'manager'))) {
      return { ok: false, reason: 'forbidden' as const }
    }
    if (folder.isInactive) return { ok: false, reason: 'inactive' as const }
    const beforeFolders = await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select f.id, f.is_inactive as "isInactive"
        from folders f
       where f.id in (${descendants}) and f.org_id = ${orgId}
       order by f.id
       for update
    `)
    const beforeFiles = await tx.execute<{ id: string; isInactive: boolean; isProtected: boolean }>(sql`
      select fi.id, fi.is_inactive as "isInactive",
             exists (select 1 from ap_capture_items ci where ci.file_id = fi.id and ci.org_id = ${orgId}) as "isProtected"
        from files fi
       where fi.folder_id in (${descendants}) and fi.org_id = ${orgId}
       order by fi.id
       for update
    `)
    // Retained evidence must never be hidden by a subtree trash: fail the whole
    // folder closed when any live contained file is retained (checked after the
    // file-row locks above, inside the same transaction). The per-file update
    // below repeats the exclusion so a concurrent link can only newly protect.
    const retained = (await tx.execute(sql`
      select 1 from files fi
       where fi.folder_id in (${descendants}) and fi.org_id = ${orgId} and not fi.is_inactive
         and ${retainedFileEvidence(orgId, sql`fi.id`)}
       limit 1
    `))
    if (retained.rows.length > 0) return { ok: false, reason: 'retained' as const }
    await tx.execute(sql`update folders set is_inactive = true, updated_at = now() where id in (${descendants}) and org_id = ${orgId}`)
    await tx.execute(sql`
      update files set is_inactive = true, updated_at = now()
       where folder_id in (${descendants}) and org_id = ${orgId} and not is_inactive
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
         and not ${retainedFileEvidence(orgId, sql`files.id`)}
    `)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'delete',
        changes: {
          permanent: false,
          before: { folders: beforeFolders.rows, files: beforeFiles.rows },
          after: {
            folders: beforeFolders.rows.map(({ id: folderId }) => ({ id: folderId, isInactive: true })),
            files: beforeFiles.rows.map(({ id: fileId, isInactive, isProtected }) => ({
              id: fileId,
              isInactive: isProtected ? isInactive : true,
            })),
          },
        },
        executor: tx,
      })
    }
    return { ok: true as const }
  }, audit?.viewer ? orgId : undefined)
  return result
}

/** Restore a trashed folder subtree (folder + descendants + their files). */
export async function restoreFolder(
  orgId: string,
  id: string,
  audit: FileMutationAudit,
): Promise<boolean> {
  return runMutation(audit.executor, async (tx) => {
    const descendants = FOLDER_DESCENDANTS(orgId, id)

    // Lock and retain the complete pre-restore state before changing either
    // table. The audit row describes the whole subtree, not just the root
    // folder, so a reviewer can verify exactly which rows were reactivated.
    const beforeFolders = await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select f.id, f.is_inactive as "isInactive"
        from folders f
       where f.id in (${descendants}) and f.org_id = ${orgId}
       order by f.id
       for update
    `)
    if (beforeFolders.rows.length === 0) return false
    // Restores by definition operate on trashed folders: include inactive rows.
    if (!(await viewerFolderGate(tx, orgId, audit, id, 'manager', { includeInactive: true }))) return false

    const beforeFiles = await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select fi.id, fi.is_inactive as "isInactive"
        from files fi
       where fi.folder_id in (${descendants}) and fi.org_id = ${orgId}
       order by fi.id
       for update
    `)

    // Restore is the exact inverse of the trash: deleteFolder recorded which
    // rows it actually deactivated and which were ALREADY in the trash (a file
    // or sub-folder the user trashed on its own beforehand). Those keep their
    // own trash entry and their own restore; resurrecting them here would
    // silently undo a separate, audited decision. Without evidence (a delete
    // that predates audited trashing) the whole subtree is restored.
    const evidence = (await tx.execute<{ changes: FolderDeleteEvidence }>(sql`
      select changes
        from audit_log
       where org_id = ${orgId} and table_name = 'folders' and row_id = ${id}
         and action = 'delete' and changes ->> 'event' = 'delete'
       order by at desc
       limit 1
    `)).rows[0]?.changes
    const keepFolders = new Set(
      (evidence?.before?.folders ?? []).filter((row) => row.isInactive).map((row) => row.id),
    )
    const keepFiles = new Set(
      (evidence?.before?.files ?? []).filter((row) => row.isInactive).map((row) => row.id),
    )
    const foldersToRestore = beforeFolders.rows.filter((row) => !keepFolders.has(row.id)).map((row) => row.id)
    const filesToRestore = beforeFiles.rows.filter((row) => !keepFiles.has(row.id)).map((row) => row.id)

    if (foldersToRestore.length > 0) {
      await tx.execute(sql`
        update folders
           set is_inactive = false, updated_at = now()
         where id in (${descendants}) and org_id = ${orgId}
           and id = any(${`{${foldersToRestore.join(',')}}`}::uuid[])
      `)
    }
    if (filesToRestore.length > 0) {
      await tx.execute(sql`
        update files
           set is_inactive = false, updated_at = now()
         where folder_id in (${descendants}) and org_id = ${orgId}
           and id = any(${`{${filesToRestore.join(',')}}`}::uuid[])
      `)
    }

    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'folders',
      rowId: id,
      action: 'restore',
      changes: {
        before: { folders: beforeFolders.rows, files: beforeFiles.rows },
        after: {
          folders: beforeFolders.rows.map(({ id: folderId, isInactive }) => ({
            id: folderId,
            isInactive: keepFolders.has(folderId) ? isInactive : false,
          })),
          files: beforeFiles.rows.map(({ id: fileId, isInactive }) => ({
            id: fileId,
            isInactive: keepFiles.has(fileId) ? isInactive : false,
          })),
        },
      },
      executor: tx,
    })
    return true
  }, audit.viewer ? orgId : undefined)
}

/** Shape of deleteFolder's audit evidence consulted by restoreFolder. */
interface FolderDeleteEvidence {
  before?: {
    folders?: Array<{ id: string; isInactive: boolean }>
    files?: Array<{ id: string; isInactive: boolean }>
  }
}

/**
 * Permanently delete a folder subtree — files, versions, blobs, attachment
 * links, and the folders. Fails if it contains files attached to records
 * (matching source platform). System folders cannot be purged.
 */
export async function purgeFolder(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<{ ok: boolean; reason?: string }> {
  // The folder and all descendant file rows are locked before checking
  // attachments.  Attachment inserts take a key-share lock on their file
  // through the FK, so a concurrent attach either wins before this check (and
  // blocks the purge) or waits until after the deleted file is gone and fails.
  // This closes the check/delete race without relying on a process-local lock.
  const outcome = await inDbTransaction(async (tx) => {
    if (audit?.viewer) await lockCabinetAuthorization(tx, orgId)
    const descendants = sql`
      with recursive descendants as (
        select id from folders where id = ${id} and org_id = ${orgId}
        union
        select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
      )
      select id from descendants`
    const folder = (await tx.execute<{ id: string; isSystem: boolean }>(sql`
      select id, is_system as "isSystem"
        from folders
       where id = ${id} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!folder) return { ok: false as const, reason: 'not found' as const }
    if (folder.isSystem) return { ok: false as const, reason: 'system' as const }
    if (!(await viewerFolderGate(tx, orgId, audit, id, 'manager'))) {
      return { ok: false as const, reason: 'forbidden' as const }
    }

    // Lock every file in the subtree before evaluating attachments.  The FK
    // on file_attachments.file_id serializes inserts against these locks.
    await tx.execute<{ id: string }>(sql`
      select fi.id
        from files fi
       where fi.org_id = ${orgId} and fi.folder_id in (${descendants})
       for update
    `)
    const attached = await tx.execute(sql`
      select 1
        from file_attachments fa
        join files fi on fi.id = fa.file_id and fi.org_id = fa.org_id
       where fa.org_id = ${orgId}
         and fi.folder_id in (${descendants})
       limit 1
    `)
    if (attached.rows.length > 0) return { ok: false as const, reason: 'has attached files' as const }
    // Pinned references with no attachment row (payment artifacts, HRM
    // documents, mandate proofs) dangle the same way when bytes are purged.
    const pinned = (await tx.execute(sql`
      select 1
        from files fi
       where fi.org_id = ${orgId}
         and fi.folder_id in (${descendants})
         and ${retainedFileEvidence(orgId, sql`fi.id`)}
       limit 1
    `))
    if (pinned.rows.length > 0) return { ok: false as const, reason: 'retained' as const }

    const s3Versions = (await tx.execute<{ id: string; file_id: string }>(sql`
      select fv.id, fv.file_id from file_versions fv
      join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
      where fi.folder_id in (${descendants}) and fv.storage_kind = 's3'
    `))
    await tx.execute(sql`
      delete from file_blobs where version_id in (
        select fv.id from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
        where fi.folder_id in (${descendants})
      )
    `)
    await tx.execute(sql`
      update files set current_version_id = null
       where folder_id in (${descendants}) and org_id = ${orgId}
    `)
    await tx.execute(sql`
      delete from file_versions fv
      using files fi
      where fv.file_id = fi.id and fi.org_id = ${orgId}
        and fi.folder_id in (${descendants})
    `)
    await tx.execute(sql`
      delete from file_attachments
       where org_id = ${orgId} and file_id in (
         select fi.id from files fi
          where fi.folder_id in (${descendants}) and fi.org_id = ${orgId}
       )
    `)
    // Subtree before-state inventory for the purge event: purged rows are
    // unrecoverable, so the audit carries folder/file identities (and
    // per-file version/attachment counts) alongside the permanent flag.
    // Read after the row locks above, inside the same transaction.
    const beforeFolders = audit ? await tx.execute<{ id: string; name: string }>(sql`
      select f.id, f.name from folders f
       where f.id in (${descendants}) and f.org_id = ${orgId}
       order by f.id
       for update
    `) : null
    const beforeFiles = audit ? await tx.execute<{
      id: string; folderId: string; name: string; contentType: string; sizeBytes: number; versions: number; attachments: number
    }>(sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.content_type as "contentType",
             fi.size_bytes as "sizeBytes",
             (select count(*)::int from file_versions fv where fv.file_id = fi.id) as versions,
             (select count(*)::int from file_attachments fa where fa.file_id = fi.id and fa.org_id = ${orgId}) as attachments
        from files fi
       where fi.folder_id in (${descendants}) and fi.org_id = ${orgId}
       order by fi.id
    `) : null
    await tx.execute(sql`
      delete from files where folder_id in (${descendants}) and org_id = ${orgId}
    `)
    await tx.execute(sql`delete from folders where id in (${descendants}) and org_id = ${orgId}`)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'delete',
        changes: { permanent: true, before: { folders: beforeFolders!.rows, files: beforeFiles!.rows } },
        executor: tx,
      })
    }
    await enqueueCabinetCleanup(tx, orgId, s3Versions.rows)
    return { ok: true as const, s3VersionIds: s3Versions.rows.map((v) => v.id) }
  })
  if (!outcome.ok) return outcome
  await deleteS3Blobs(outcome.s3VersionIds)
  return { ok: true }
}
