/** Split from web/lib/file-cabinet.ts (ARCH-FILE-SPLIT; pure moves only). */
import 'server-only'
import { type FileViewer, type AccessLevel, ACCESS_BY_RANK, maxAccess, grantAppliesTo } from './types'
import { sql, type SQL } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

// --- helpers ----------------------------------------------------------------

export function deriveExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Resolve the set of folder ids hidden from this viewer — private folders owned
 * by someone else, plus everything beneath them. Computed ONCE per request (a
 * single recursive walk) so read queries can filter with a cheap membership
 * test instead of re-evaluating a correlated recursive CTE for every candidate
 * row. Admins hide nothing (empty set); orgs with no private folders (the
 * common case) also resolve to an empty set, making the predicate a no-op.
 */
/**
 * The caller's read scope for list/tree queries, resolved once per request:
 *   - hiddenFolderIds: folders the caller cannot see — private subtrees owned
 *     by someone else, MINUS any such subtree re-opened to the caller by a
 *     folder grant.
 *   - grantedFileIds: individual files shared directly with the caller (visible
 *     even when their folder is hidden).
 * Admins (and, effectively, orgs with no private folders or grants) resolve to
 * empty sets — the predicates become no-ops.
 */
export interface ReadScope {
  hiddenFolderIds: string[]
  grantedFileIds: string[]
  apCaptureFolderIds: string[]
}

export async function resolveReadScope(orgId: string, viewer: FileViewer): Promise<ReadScope> {
  // Private subtrees owned by others (hidden from the org-role baseline).
  const hiddenRes = viewer.isAdmin ? { rows: [] as { id: string }[] } : (await db.execute<{ id: string }>(sql`
    with recursive hidden_folders as (
      select id from folders
       where org_id = ${orgId} and is_private and owner_id is distinct from ${viewer.userId}
      union
      select f.id from folders f
        join hidden_folders h on f.parent_folder_id = h.id
       where f.org_id = ${orgId}
    )
    select id from hidden_folders
  `))
  const hidden = new Set(hiddenRes.rows.map((x) => x.id))

  // Folders granted to the caller (or a role they hold) re-open their whole
  // subtree; subtract them from the hidden set.
  if (hidden.size > 0) {
    const grantedRes = (await db.execute<{ id: string }>(sql`
      with recursive granted as (
        select g.resource_id as id
          from resource_grants g
         where g.org_id = ${orgId} and g.resource_type = 'folder' and ${grantAppliesTo(orgId, viewer)}
        union
        select f.id from folders f
          join granted gr on f.parent_folder_id = gr.id
         where f.org_id = ${orgId}
      )
      select id from granted
    `))
    for (const row of grantedRes.rows) hidden.delete(row.id)
  }

  // AP intake files need the owning AP permission even when an explicit file
  // grant would otherwise reopen a hidden/private file. Record this subtree
  // separately so the file grant cannot override the capability boundary.
  const apCaptureFolders = viewer.canReadApCapture === true
    ? []
    : (await db.execute<{ id: string }>(sql`
        with recursive capture_folders as (
          select id from folders where org_id = ${orgId} and system_kind = 'ap_capture'
          union all
          select f.id from folders f join capture_folders c on f.parent_folder_id = c.id
           where f.org_id = ${orgId}
        )
        select id from capture_folders
      `)).rows.map((row) => row.id)
  for (const id of apCaptureFolders) hidden.add(id)

  // Files shared directly with the caller.
  const fileGrants = (await db.execute<{ id: string }>(sql`
    select g.resource_id as id from resource_grants g
     where g.org_id = ${orgId} and g.resource_type = 'file' and ${grantAppliesTo(orgId, viewer)}
  `))

  return { hiddenFolderIds: [...hidden], grantedFileIds: fileGrants.rows.map((x) => x.id), apCaptureFolderIds: apCaptureFolders }
}

/**
 * Visibility predicate for folders, built from a pre-resolved hidden set. TRUE
 * when `folderIdCol` is not hidden. An empty set short-circuits to `true`. The
 * set is bound as one jsonb param (never raw-interpolated) so any size is valid.
 */
export function visibleFolderPredicate(hidden: string[], folderIdCol: SQL): SQL {
  if (hidden.length === 0) return sql`true`
  return sql`${folderIdCol} not in (
    select value::uuid from jsonb_array_elements_text(${JSON.stringify(hidden)}::jsonb) as _h(value)
  )`
}

/**
 * Visibility predicate for files: visible when the file's folder is not hidden,
 * OR the file itself was shared with the caller.
 */
export function visibleFilePredicate(scope: ReadScope, folderIdCol: SQL, fileIdCol: SQL): SQL {
  const folderOk = visibleFolderPredicate(scope.hiddenFolderIds, folderIdCol)
  const apCaptureOk = visibleFolderPredicate(scope.apCaptureFolderIds, folderIdCol)
  if (scope.grantedFileIds.length === 0) return sql`${apCaptureOk} and ${folderOk}`
  return sql`${apCaptureOk} and (${folderOk} or ${fileIdCol} in (
    select value::uuid from jsonb_array_elements_text(${JSON.stringify(scope.grantedFileIds)}::jsonb) as _g(value)
  ))`
}

/**
 * Per-table subsidiary visibility for a (table, id) record reference, mirroring
 * attachmentTargetInScope (web/app/api/file-cabinet/lib.ts) table by table.
 * Item-rate versions are org-wide setup (no subsidiary dimension). Unknown
 * tables and deleted targets match nothing — fail closed. `fence` is the
 * `{uuid,...}` array literal of the caller's allowed subsidiaries.
 */
function subsidiaryTargetVisibleSql(
  orgId: string,
  fence: string,
  tableCol: SQL,
  idCol: SQL,
): SQL {
  return sql`(
    ${tableCol} = 'item_rate_versions'
    or exists (select 1 from documents d
                 where d.org_id = ${orgId} and d.id = ${idCol} and ${tableCol} = 'documents'
                   and d.subsidiary_id = any(${fence}::uuid[]))
    or exists (select 1 from parties p
                 where p.org_id = ${orgId} and p.id = ${idCol} and ${tableCol} = 'parties'
                   and (p.subsidiary_id is null or p.subsidiary_id = any(${fence}::uuid[])))
    or exists (select 1 from fixed_assets fx
                 where fx.org_id = ${orgId} and fx.id = ${idCol} and ${tableCol} = 'fixed_assets'
                   and fx.subsidiary_id = any(${fence}::uuid[]))
    or exists (select 1 from compliance_records cr
                 join parties p on p.id = cr.party_id and p.org_id = cr.org_id
                 left join projects pj on pj.id = cr.project_id and pj.org_id = cr.org_id
                where cr.org_id = ${orgId} and cr.id = ${idCol} and ${tableCol} = 'compliance_records'
                  and (p.subsidiary_id is null or p.subsidiary_id = any(${fence}::uuid[]))
                  and (pj.id is null or pj.subsidiary_id is null or pj.subsidiary_id = any(${fence}::uuid[])))
    or exists (select 1 from lien_waivers lw
                 join parties p on p.id = lw.party_id and p.org_id = lw.org_id
                 left join projects pj on pj.id = lw.project_id and pj.org_id = lw.org_id
                where lw.org_id = ${orgId} and lw.id = ${idCol} and ${tableCol} = 'lien_waivers'
                  and (p.subsidiary_id is null or p.subsidiary_id = any(${fence}::uuid[]))
                  and (pj.id is null or pj.subsidiary_id is null or pj.subsidiary_id = any(${fence}::uuid[])))
  )`
}

/**
 * Record-entity fence for cabinet reads: a file or folder inside a per-record
 * folder (record_id set) evidences that record, so a subsidiary-restricted
 * caller sees it only when the folder's record target is inside their fence.
 * Non-record folders are unaffected. Returns null when the caller is
 * unrestricted.
 */
export function recordTargetVisiblePredicate(
  orgId: string,
  allowed: ReadonlySet<string> | null | undefined,
  recordTableCol: SQL,
  recordIdCol: SQL,
): SQL | null {
  if (allowed === null || allowed === undefined) return null
  const fence = `{${[...allowed].join(',')}}`
  return sql`(
    ${recordIdCol} is null
    or ${subsidiaryTargetVisibleSql(orgId, fence, recordTableCol, recordIdCol)}
  )`
}

/**
 * Attachment-target fence for cabinet reads: a file evidences every record it
 * is attached to, not just the record (if any) of the folder it sits in.
 * Moving a file out of a scoped record leaf — or linking a common-folder file
 * to a scoped record — must not launder its bytes into another subsidiary's
 * list/download reach. Every attachment target must be inside the caller's
 * fence; files with no links are unaffected. Returns null when the caller is
 * unrestricted.
 */
export function attachmentTargetsVisiblePredicate(
  orgId: string,
  allowed: ReadonlySet<string> | null | undefined,
  fileIdCol: SQL,
): SQL | null {
  if (allowed === null || allowed === undefined) return null
  const fence = `{${[...allowed].join(',')}}`
  return sql`(
    not exists (
      select 1 from file_attachments fa
       where fa.org_id = ${orgId} and fa.file_id = ${fileIdCol}
         and not (${subsidiaryTargetVisibleSql(orgId, fence, sql`fa.target_table`, sql`fa.target_id`)})
    )
  )`
}

/**
 * File-level record fence: the folder-record target AND every attachment
 * target must be visible, unless the file itself was explicitly shared with
 * the caller (a grant re-opens its file exactly like a grant re-opens a
 * private subtree).
 */
/**
 * File-level legal-entity fence. A resource grant can reopen privacy-hidden
 * content, but it cannot grant access across a subsidiary boundary.
 */
export function recordScopeFilePredicate(
  orgId: string,
  allowed: ReadonlySet<string> | null | undefined,
  fileIdCol: SQL,
  recordTableCol: SQL,
  recordIdCol: SQL,
): SQL {
  const targetVisible = recordTargetVisiblePredicate(orgId, allowed, recordTableCol, recordIdCol)
  const attachmentsVisible = attachmentTargetsVisiblePredicate(orgId, allowed, fileIdCol)
  if (!targetVisible && !attachmentsVisible) return sql`true`
  return sql`(${targetVisible ?? sql`true`} and ${attachmentsVisible ?? sql`true`})`
}

/** A file belongs to the org and is not a DSAR export reserved for its HR
 * permission-gated delivery route. Trash membership is conditional: live
 * reads exclude trashed files, while the trash lifecycle (restore/purge
 * rechecks) resolves them — but a subject export stays excluded on BOTH
 * branches, so it can never resolve through the trash lifecycle. The live
 * fence and fileAccessLevel's includeInactive branch both derive from this
 * one predicate so they cannot drift. */
export function ownedFilePredicate(orgId: string, options: { includeInactive?: boolean } = {}): SQL {
  return sql`fi.org_id = ${orgId}${options.includeInactive ? sql`` : sql` and not fi.is_inactive`}
    and not exists (
      select 1 from hrm_data_subject_exports ds
       where ds.org_id = fi.org_id and ds.file_id = fi.id
    )`
}

/** A live file belongs to the org, is not in trash, and is not a DSAR export
 * reserved for its HR permission-gated delivery route. */
export function liveFilePredicate(orgId: string): SQL {
  return ownedFilePredicate(orgId)
}

/** The shared file-row fence used by lists and every folder file-count projection. */
export function visibleFileRowPredicate(orgId: string, viewer: FileViewer, scope: ReadScope): SQL {
  return sql`${liveFilePredicate(orgId)}
    and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
    and ${recordScopeFolderPredicate(orgId, viewer, sql`fo.id`)}
    and ${recordScopeFilePredicate(orgId, viewer.allowedSubsidiaryIds, sql`fi.id`, sql`fo.record_table`, sql`fo.record_id`)}`
}

/** Query fence for consumers that build bounded manifests before loading bytes. */
export async function fileReadPredicate(orgId: string, viewer: FileViewer): Promise<SQL> {
  const scope = await resolveReadScope(orgId, viewer)
  return visibleFileRowPredicate(orgId, viewer, scope)
}

/** Privacy and subsidiary visibility for paths built by file exports. */
export async function folderPathVisiblePredicate(orgId: string, viewer: FileViewer, folderIdCol: SQL): Promise<SQL> {
  const scope = await resolveReadScope(orgId, viewer)
  return sql`${visibleFolderPredicate(scope.hiddenFolderIds, folderIdCol)}
    and ${recordScopeFolderPredicate(orgId, viewer, folderIdCol)}`
}

/**
 * Folder-level entity fence inherited through every ancestor. Privacy grants
 * never override this legal-entity boundary.
 */
export function recordScopeFolderPredicate(
  orgId: string,
  viewer: FileViewer,
  folderIdCol: SQL,
): SQL {
  const targetVisible = recordTargetVisiblePredicate(orgId, viewer.allowedSubsidiaryIds, sql`ancestor.record_table`, sql`ancestor.record_id`)
  if (!targetVisible) return sql`true`
  return sql`not exists (
    with recursive folder_ancestors as (
      select anchor.id, anchor.parent_folder_id, anchor.record_table, anchor.record_id
        from folders anchor where anchor.id = ${folderIdCol} and anchor.org_id = ${orgId}
      union all
      select parent.id, parent.parent_folder_id, parent.record_table, parent.record_id
        from folders parent join folder_ancestors child on child.parent_folder_id = parent.id
       where parent.org_id = ${orgId}
    )
    select 1 from folder_ancestors ancestor where not ${targetVisible}
  )`
}

/** SQL scalar (0–3) for the caller's max grant tier over a set of folder ids. */
function grantRankOverFolders(orgId: string, viewer: FileViewer, folderIdsCte: SQL): SQL {
  return sql`(
    select coalesce(max(case g.access when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end), 0)
      from resource_grants g
     where g.org_id = ${orgId} and g.resource_type = 'folder'
       and g.resource_id in (${folderIdsCte}) and ${grantAppliesTo(orgId, viewer)}
  )`
}

/**
 * The caller's effective access tier on a folder — the highest of admin,
 * private-owner (Manager), org-role baseline (suppressed inside a private
 * subtree the caller doesn't own), and any grant on the folder or an ancestor.
 * Ownership follows resolveReadScope: a private folder owned by someone else
 * anywhere on the ancestor chain seals the subtree off — owning one's own
 * private folder elsewhere on that chain (above or below the foreign
 * boundary) never bypasses it, so only grants confer access past it.
 */
export async function folderAccessLevel(
  orgId: string,
  viewer: FileViewer,
  folderId: string,
  executor?: SqlExecutor,
  options: { includeInactive?: boolean } = {},
): Promise<AccessLevel> {
  const exec = executor ?? db
  // Admins skip the tier query below (it binds the caller id into uuid
  // comparisons): existence alone decides, exactly as the anchor read did.
  // Trash restores and trash renames evaluate the tier of trashed folders
  // through includeInactive; liveness stays a read concern, enforced by the
  // list/get predicates, not by the tier.
  if (viewer.isAdmin && (viewer.allowedSubsidiaryIds === null || viewer.allowedSubsidiaryIds === undefined)) {
    const exists = (await exec.execute(sql`
      select 1 from folders where id = ${folderId} and org_id = ${orgId} and ${options.includeInactive ? sql`true` : sql`not is_inactive`}
    `)).rows[0]
    if (!exists) return 'none'
    return 'manager'
  }
  const recordFence = recordTargetVisiblePredicate(orgId, viewer.allowedSubsidiaryIds, sql`a.record_table`, sql`a.record_id`)
  const r = (await exec.execute<{ n: number; ownsPrivate: boolean | null; foreignPrivate: boolean | null; grantRank: number; recordVisible: boolean }>(sql`
    with recursive ancestors as (
      select id, parent_folder_id, is_private, owner_id, record_table, record_id
        from folders where id = ${folderId} and org_id = ${orgId} and ${options.includeInactive ? sql`true` : sql`not is_inactive`}
      union all
      select f.id, f.parent_folder_id, f.is_private, f.owner_id, f.record_table, f.record_id
        from folders f join ancestors a on f.id = a.parent_folder_id and f.org_id = ${orgId}
    )
    select
      count(*)::int as "n",
      bool_or(a.is_private and a.owner_id = ${viewer.userId}) as "ownsPrivate",
      bool_or(a.is_private and a.owner_id is distinct from ${viewer.userId}) as "foreignPrivate",
      ${grantRankOverFolders(orgId, viewer, sql`select id from ancestors`)} as "grantRank",
      bool_and(${recordFence ?? sql`true`}) as "recordVisible"
      from ancestors a
  `))
  const row = r.rows[0]
  // The aggregate always returns exactly one row — even when the anchor folder
  // does not exist (count zero, every other column null). An absent resource
  // must read as 'none': without this check every documents.manage caller is a
  // manager of every random UUID, and grant writes persist dangling rows.
  if (!row || row.n === 0) return 'none' // folder not found / not in org
  if (viewer.allowedSubsidiaryIds !== null && viewer.allowedSubsidiaryIds !== undefined && !row.recordVisible) return 'none'
  if (viewer.isAdmin) return 'manager'
  const behindForeignBoundary = !!row.foreignPrivate
  const grantLevel = ACCESS_BY_RANK[row.grantRank] ?? 'none'
  const ownerLevel: AccessLevel = row.ownsPrivate && !behindForeignBoundary ? 'manager' : 'none'
  const baselineLevel: AccessLevel = behindForeignBoundary ? 'none' : viewer.baseline ?? 'viewer'
  return maxAccess(grantLevel, ownerLevel, baselineLevel)
}

/** The caller's effective access tier on a file: the max of its folder's tier
 *  and any grant on the file itself, after the non-overridable subsidiary and
 *  attachment-target fences have been applied. */
export async function fileAccessLevel(
  orgId: string,
  viewer: FileViewer,
  fileId: string,
  executor?: SqlExecutor,
  options: { includeInactive?: boolean } = {},
): Promise<AccessLevel> {
  const exec = executor ?? db
  const folderFence = recordScopeFolderPredicate(orgId, viewer, sql`fo.id`)
  const attachFence = attachmentTargetsVisiblePredicate(orgId, viewer.allowedSubsidiaryIds, sql`fi.id`)
  const r = (await exec.execute<{ folderId: string; grantRank: number; folderRecordVisible: boolean; attachVisible: boolean }>(sql`
    select fi.folder_id as "folderId",
      (select coalesce(max(case g.access when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end), 0)
         from resource_grants g
        where g.org_id = ${orgId} and g.resource_type = 'file' and g.resource_id = fi.id
          and ${grantAppliesTo(orgId, viewer)}) as "grantRank",
      ${folderFence ?? sql`true`} as "folderRecordVisible",
      ${attachFence ?? sql`true`} as "attachVisible"
      from files fi left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
     where fi.id = ${fileId} and ${ownedFilePredicate(orgId, options)}
  `))
  const row = r.rows[0]
  if (!row) return 'none'
  if (viewer.allowedSubsidiaryIds !== null && viewer.allowedSubsidiaryIds !== undefined
      && (!row.folderRecordVisible || !row.attachVisible)) return 'none'
  if (viewer.isAdmin) return 'manager'
  const fileGrant = ACCESS_BY_RANK[row.grantRank] ?? 'none'
  const folderLevel = await folderAccessLevel(orgId, viewer, row.folderId, exec)
  return maxAccess(fileGrant, folderLevel)
}
