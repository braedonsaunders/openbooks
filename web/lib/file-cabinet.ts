import 'server-only'
import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db, inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import { activeStorageKind, deleteS3Blobs, getS3Blob, putS3Blob } from './file-storage'
import { recordFileEvent } from './file-audit'

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
 * The authenticated caller, for access control. Beyond private-folder
 * visibility (is_private → owner + admins only), access is layered:
 *   - isAdmin (holds '*') → Manager everywhere.
 *   - baseline: the org-role tier — 'manager' for documents.manage, 'viewer'
 *     for documents.read — applied to every folder outside a private subtree
 *     the caller doesn't own. Defaults to 'viewer' when unset (back-compat:
 *     every caller that reaches these functions already passed documents.read).
 *   - resource_grants add Viewer/Editor/Manager to specific users/roles on a
 *     folder (inherited by descendants + contained files) or a single file.
 */
export interface FileViewer {
  userId: string
  isAdmin: boolean
  baseline?: AccessLevel
}

/** Access tiers, low → high. 'none' means no access. */
export type AccessLevel = 'none' | 'viewer' | 'editor' | 'manager'

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, editor: 2, manager: 3 }
const ACCESS_BY_RANK: AccessLevel[] = ['none', 'viewer', 'editor', 'manager']

export function accessAtLeast(level: AccessLevel, min: AccessLevel): boolean {
  return ACCESS_RANK[level] >= ACCESS_RANK[min]
}

function maxAccess(...levels: AccessLevel[]): AccessLevel {
  return ACCESS_BY_RANK[Math.max(0, ...levels.map((l) => ACCESS_RANK[l]))]!
}

/** SQL predicate: a grant row applies to this viewer (direct user grant, or a
 *  grant to a role the viewer holds via role_assignments). */
function grantAppliesTo(orgId: string, viewer: FileViewer): SQL {
  return sql`(
    (g.principal_type = 'user' and g.principal_id = ${viewer.userId})
    or (g.principal_type = 'role' and g.principal_id in (
      select role_id from role_assignments where org_id = ${orgId} and user_id = ${viewer.userId}
    ))
  )`
}

export type FolderNode = {
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
};

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
}

async function resolveReadScope(orgId: string, viewer: FileViewer): Promise<ReadScope> {
  if (viewer.isAdmin) return { hiddenFolderIds: [], grantedFileIds: [] }

  // Private subtrees owned by others (hidden from the org-role baseline).
  const hiddenRes = (await db.execute<{ id: string }>(sql`
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

  // Files shared directly with the caller.
  const fileGrants = (await db.execute<{ id: string }>(sql`
    select g.resource_id as id from resource_grants g
     where g.org_id = ${orgId} and g.resource_type = 'file' and ${grantAppliesTo(orgId, viewer)}
  `))

  return { hiddenFolderIds: [...hidden], grantedFileIds: fileGrants.rows.map((x) => x.id) }
}

/**
 * Visibility predicate for folders, built from a pre-resolved hidden set. TRUE
 * when `folderIdCol` is not hidden. An empty set short-circuits to `true`. The
 * set is bound as one jsonb param (never raw-interpolated) so any size is valid.
 */
function visibleFolderPredicate(hidden: string[], folderIdCol: SQL): SQL {
  if (hidden.length === 0) return sql`true`
  return sql`${folderIdCol} not in (
    select value::uuid from jsonb_array_elements_text(${JSON.stringify(hidden)}::jsonb) as _h(value)
  )`
}

/**
 * Visibility predicate for files: visible when the file's folder is not hidden,
 * OR the file itself was shared with the caller.
 */
function visibleFilePredicate(scope: ReadScope, folderIdCol: SQL, fileIdCol: SQL): SQL {
  const folderOk = visibleFolderPredicate(scope.hiddenFolderIds, folderIdCol)
  if (scope.grantedFileIds.length === 0) return folderOk
  return sql`(${folderOk} or ${fileIdCol} in (
    select value::uuid from jsonb_array_elements_text(${JSON.stringify(scope.grantedFileIds)}::jsonb) as _g(value)
  ))`
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
): Promise<AccessLevel> {
  if (viewer.isAdmin) return 'manager'
  const r = (await db.execute<{ ownsPrivate: boolean | null; foreignPrivate: boolean | null; grantRank: number }>(sql`
    with recursive ancestors as (
      select id, parent_folder_id, is_private, owner_id
        from folders where id = ${folderId} and org_id = ${orgId}
      union all
      select f.id, f.parent_folder_id, f.is_private, f.owner_id
        from folders f join ancestors a on f.id = a.parent_folder_id and f.org_id = ${orgId}
    )
    select
      bool_or(a.is_private and a.owner_id = ${viewer.userId}) as "ownsPrivate",
      bool_or(a.is_private and a.owner_id is distinct from ${viewer.userId}) as "foreignPrivate",
      ${grantRankOverFolders(orgId, viewer, sql`select id from ancestors`)} as "grantRank"
      from ancestors a
  `))
  const row = r.rows[0]
  if (!row) return 'none' // folder not found / not in org
  const behindForeignBoundary = !!row.foreignPrivate
  const grantLevel = ACCESS_BY_RANK[row.grantRank] ?? 'none'
  const ownerLevel: AccessLevel = row.ownsPrivate && !behindForeignBoundary ? 'manager' : 'none'
  const baselineLevel: AccessLevel = behindForeignBoundary ? 'none' : viewer.baseline ?? 'viewer'
  return maxAccess(grantLevel, ownerLevel, baselineLevel)
}

/** The caller's effective access tier on a file: the max of its folder's tier
 *  and any grant on the file itself. */
export async function fileAccessLevel(
  orgId: string,
  viewer: FileViewer,
  fileId: string,
): Promise<AccessLevel> {
  if (viewer.isAdmin) return 'manager'
  const r = (await db.execute<{ folderId: string; grantRank: number }>(sql`
    select fi.folder_id as "folderId",
      (select coalesce(max(case g.access when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end), 0)
         from resource_grants g
        where g.org_id = ${orgId} and g.resource_type = 'file' and g.resource_id = fi.id
          and ${grantAppliesTo(orgId, viewer)}) as "grantRank"
      from files fi where fi.id = ${fileId} and fi.org_id = ${orgId}
  `))
  const row = r.rows[0]
  if (!row) return 'none'
  const fileGrant = ACCESS_BY_RANK[row.grantRank] ?? 'none'
  const folderLevel = await folderAccessLevel(orgId, viewer, row.folderId)
  return maxAccess(fileGrant, folderLevel)
}

// --- sharing / grants -------------------------------------------------------

export type ResourceType = 'folder' | 'file'
export type PrincipalType = 'user' | 'role'

export type GrantRow = {
  id: string
  principalType: PrincipalType
  principalId: string
  principalName: string
  access: AccessLevel
};

const ACCESS_VALUES: AccessLevel[] = ['viewer', 'editor', 'manager']
export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === 'string' && (ACCESS_VALUES as string[]).includes(v)
}

/** The grants on a resource, with resolved principal display names. */
export async function listGrants(
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<GrantRow[]> {
  const r = (await db.execute<GrantRow>(sql`
    select g.id, g.principal_type as "principalType", g.principal_id as "principalId", g.access,
           coalesce(u.name, u.email, ar.name, 'Unknown') as "principalName"
      from resource_grants g
      left join users u on g.principal_type = 'user' and u.id = g.principal_id and u.org_id = ${orgId}
      left join app_roles ar on g.principal_type = 'role' and ar.id = g.principal_id and ar.org_id = ${orgId}
     where g.org_id = ${orgId} and g.resource_type = ${resourceType} and g.resource_id = ${resourceId}
     order by g.principal_type, "principalName"
  `))
  return r.rows
}

/** Create or update a grant (idempotent on principal). */
export async function setGrant(input: {
  orgId: string
  resourceType: ResourceType
  resourceId: string
  principalType: PrincipalType
  principalId: string
  access: AccessLevel
  actorId: string
  audit?: FileMutationAudit
}): Promise<void> {
  await inDbTransaction(async (tx) => {
    const previous = (await tx.execute<{ id: string; access: AccessLevel }>(sql`
      select id, access
        from resource_grants
       where org_id = ${input.orgId}
         and resource_type = ${input.resourceType}
         and resource_id = ${input.resourceId}
         and principal_type = ${input.principalType}
         and principal_id = ${input.principalId}
       for update
    `)).rows[0]
    const result = (await tx.execute<{ id: string }>(sql`
      insert into resource_grants
        (org_id, resource_type, resource_id, principal_type, principal_id, access, created_by, updated_by, created_at, updated_at)
      values (${input.orgId}, ${input.resourceType}, ${input.resourceId}, ${input.principalType},
              ${input.principalId}, ${input.access}, ${input.actorId}, ${input.actorId}, now(), now())
      on conflict (org_id, resource_type, resource_id, principal_type, principal_id)
      do update set access = ${input.access}, updated_by = ${input.actorId}, updated_at = now()
      where resource_grants.org_id = ${input.orgId}
      returning id
    `)).rows[0]
    if (!result) throw new Error('grant upsert did not return a row')
    if (input.audit) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.audit.actorId,
        table: input.resourceType === 'folder' ? 'folders' : 'files',
        rowId: input.resourceId,
        action: 'share',
        changes: {
          principalType: input.principalType,
          principalId: input.principalId,
          access: input.access,
          previousAccess: previous?.access ?? null,
        },
        executor: tx,
      })
    }
  })
}

/** Remove a grant by id, bound to the resource the caller authorized. */
export async function removeGrant(
  orgId: string,
  grantId: string,
  resourceType: ResourceType,
  resourceId: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  return inDbTransaction(async (tx) => {
    const existing = (await tx.execute<{ id: string; resourceType: ResourceType; resourceId: string }>(sql`
      select id, resource_type as "resourceType", resource_id as "resourceId"
        from resource_grants
       where id = ${grantId} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!existing || existing.resourceType !== resourceType || existing.resourceId !== resourceId) return false
    const deleted = (await tx.execute<{ id: string }>(sql`
      delete from resource_grants
       where id = ${grantId} and org_id = ${orgId}
         and resource_type = ${resourceType} and resource_id = ${resourceId}
      returning id
    `)).rows.length > 0
    if (!deleted) return false
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: resourceType === 'folder' ? 'folders' : 'files',
        rowId: resourceId,
        action: 'unshare',
        changes: { grantId },
        executor: tx,
      })
    }
    return true
  })
}

/** Title-case a snake_case identifier: "vendor_bill" -> "Vendor Bill". Must
 *  match the SQL backfill (initcap(replace(kind,'_',' '))) so grouping folders
 *  created here and by the migration resolve to the same name. */
export function titleizeKind(s: string): string {
  return s
    .split('_')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
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
  const existing = (await db.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and system_kind = 'attachments'
  `))
  if (existing.rows.length > 0) return existing.rows[0]!.id
  const ins = (await db.execute<{ id: string }>(sql`
    insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
    values (${orgId}, 'Attachments', true, 'attachments', now(), now())
    returning id
  `))
  return ins.rows[0]!.id
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
): Promise<string> {
  return db.transaction(async (tx) => {
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
  })
}

/** Resolve the kind group label for a record: document kind for `documents`,
 *  else the titleized table name. Falls back to "Documents" for orphaned rows. */
async function groupLabelFor(orgId: string, recordTable: string, recordId: string): Promise<string> {
  if (recordTable !== 'documents') return titleizeKind(recordTable)
  const r = (await db.execute<{ kind: string | null }>(sql`
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
): Promise<string> {
  const existing = (await db.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and record_table = ${recordTable} and record_id = ${recordId}
       and record_id is not null
  `))
  if (existing.rows.length > 0) return existing.rows[0]!.id
  const rootId = await ensureAttachmentsRoot(orgId)
  const label = await groupLabelFor(orgId, recordTable, recordId)
  const groupId = await ensureGroupFolder(orgId, rootId, recordTable, label)
  const name = `${recordTable} / ${recordId.slice(0, 8)}`
  const ins = (await db.execute<{ id: string }>(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${groupId}, ${name}, true, ${recordTable}, ${recordId}, now(), now())
    returning id
  `))
  return ins.rows[0]!.id
}

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
 * to null (a grant re-opens exactly its own subtree), and childCount counts
 * only children the viewer could actually open.
 */
export async function getFolderTree(orgId: string, viewer: FileViewer): Promise<FolderNode[]> {
  const scope = await resolveReadScope(orgId, viewer)
  const parentVisible = visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)
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
         group by parent_folder_id
      ) cc on cc.parent_folder_id = f.id
      left join (
        select folder_id, count(*)::int as n
          from files
         where org_id = ${orgId} and not is_inactive
         group by folder_id
      ) fc on fc.folder_id = f.id
     where f.org_id = ${orgId} and not f.is_inactive
       and f.record_id is null
       and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
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
  const r = (await db.execute<{ id: string; name: string; systemKind: string | null }>(sql`
    with recursive chain as (
      select id, name, system_kind, parent_folder_id, 0 as depth
        from folders f
       where f.id = ${folderId} and f.org_id = ${orgId} and ${visible}
      union all
      select f.id, f.name, f.system_kind, f.parent_folder_id, c.depth + 1
        from folders f join chain c on f.id = c.parent_folder_id and f.org_id = ${orgId}
       where ${visible}
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
  const parentVisible = scope
    ? visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)
    : sql`true`
  const childVisible = scope ? visibleFolderPredicate(scope.hiddenFolderIds, sql`c.id`) : sql`true`
  const r = (await db.execute<FolderNode & { ownerId: string | null }>(sql`
    select f.id, f.name,
           case when ${parentVisible} then f.parent_folder_id end as "parentId",
           f.is_system as "isSystem",
           f.system_kind as "systemKind", f.is_private as "isPrivate",
           f.is_inactive as "isInactive", f.record_table as "recordTable",
           f.record_id as "recordId", f.owner_id as "ownerId",
           (select count(*)::int from folders c
             where c.parent_folder_id = f.id and c.org_id = ${orgId} and ${childVisible}) as "childCount",
           (select count(*)::int from files fi where fi.folder_id = f.id and fi.org_id = ${orgId} and not fi.is_inactive) as "fileCount"
      from folders f
     where f.id = ${id} and f.org_id = ${orgId} and ${selfVisible}
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
}): Promise<string> {
  const ins = (await db.execute<{ id: string }>(sql`
    insert into folders (org_id, parent_folder_id, name, is_private, owner_id,
                         created_by, updated_by, created_at, updated_at)
    values (${input.orgId}, ${input.parentId}, ${input.name},
            ${input.isPrivate ?? false}, ${input.ownerId ?? null},
            ${input.createdBy}, ${input.createdBy}, now(), now())
    returning id
  `))
  return ins.rows[0]!.id
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
): Promise<boolean> {
  // Prevent moving into self or descendant
  if (parentId === id) return false
  if (parentId) {
    // The new parent must exist inside this org (blocks cross-org reparenting).
    const parent = (await db.execute(sql`
      select 1 from folders where id = ${parentId} and org_id = ${orgId}
    `))
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
    `))
    if (cycle.rows.length > 0) return false
  }
  const r = (await db.execute<{ id: string }>(sql`
    update folders set parent_folder_id = ${parentId}, updated_by = ${updatedBy}, updated_at = now()
     where id = ${id} and org_id = ${orgId} and not is_system
    returning id
  `))
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
  isInactive?: boolean
}

export type FolderPatchResult = { ok: true } | { ok: false; reason: 'not found' | 'cannot move folder' | 'cannot rename system folder' | 'cannot update system folder' }

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
  const hasParent = Object.prototype.hasOwnProperty.call(patch, 'parentId')
  const hasName = patch.name !== undefined
  const hasFlags = patch.isPrivate !== undefined || patch.isInactive !== undefined
  return inDbTransaction(async (tx) => {
    const before = (await tx.execute<{
      id: string
      name: string
      parentId: string | null
      isPrivate: boolean
      isInactive: boolean
      isSystem: boolean
    }>(sql`
      select id, name, parent_folder_id as "parentId", is_private as "isPrivate",
             is_inactive as "isInactive", is_system as "isSystem"
        from folders
       where id = ${id} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!before) return { ok: false as const, reason: 'not found' as const }

    if (before.isSystem && hasName) {
      return { ok: false as const, reason: 'cannot rename system folder' as const }
    }
    if (before.isSystem && hasParent) {
      return { ok: false as const, reason: 'cannot move folder' as const }
    }
    if (before.isSystem && hasFlags) {
      return { ok: false as const, reason: 'cannot update system folder' as const }
    }

    if (hasParent) {
      const parentId = patch.parentId ?? null
      if (parentId === id) return { ok: false as const, reason: 'cannot move folder' as const }
      if (parentId) {
        const parent = (await tx.execute<{ id: string }>(sql`
          select id from folders where id = ${parentId} and org_id = ${orgId} for share
        `)).rows[0]
        if (!parent) return { ok: false as const, reason: 'cannot move folder' as const }
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
      }
    }

    const updates: ReturnType<typeof sql.raw>[] = [sql`updated_by = ${updatedBy}`, sql`updated_at = now()`]
    if (hasParent) updates.push(sql`parent_folder_id = ${patch.parentId ?? null}`)
    if (hasName) updates.push(sql`name = ${patch.name}`)
    if (patch.isPrivate !== undefined) {
      updates.push(sql`is_private = ${patch.isPrivate}`)
      if (patch.isPrivate) updates.push(sql`owner_id = coalesce(owner_id, ${updatedBy})`)
    }
    if (patch.isInactive !== undefined) updates.push(sql`is_inactive = ${patch.isInactive}`)
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
          isInactive: patch.isInactive ?? before.isInactive,
        },
        executor: tx,
      })
    }
    return { ok: true as const }
  })
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
  const result = await inDbTransaction(async (tx) => {
    const descendants = FOLDER_DESCENDANTS(orgId, id)
    const folder = (await tx.execute<{ id: string; isSystem: boolean }>(sql`
      select id, is_system as "isSystem"
        from folders
       where id = ${id} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!folder) return { ok: false, reason: 'not found' as const }
    if (folder.isSystem) return { ok: false, reason: 'system' as const }
    await tx.execute(sql`update folders set is_inactive = true, updated_at = now() where id in (${descendants}) and org_id = ${orgId}`)
    await tx.execute(sql`
      update files set is_inactive = true, updated_at = now()
       where folder_id in (${descendants}) and org_id = ${orgId} and not is_inactive
         and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
    `)
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: 'folders',
        rowId: id,
        action: 'delete',
        changes: { permanent: false },
        executor: tx,
      })
    }
    return { ok: true as const }
  })
  return result
}

/** Restore a trashed folder subtree (folder + descendants + their files). */
export async function restoreFolder(
  orgId: string,
  id: string,
  audit: FileMutationAudit,
): Promise<boolean> {
  return inDbTransaction(async (tx) => {
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

    const beforeFiles = await tx.execute<{ id: string; isInactive: boolean }>(sql`
      select fi.id, fi.is_inactive as "isInactive"
        from files fi
       where fi.folder_id in (${descendants}) and fi.org_id = ${orgId}
       order by fi.id
       for update
    `)

    await tx.execute(sql`
      update folders
         set is_inactive = false, updated_at = now()
       where id in (${descendants}) and org_id = ${orgId}
    `)
    await tx.execute(sql`
      update files
         set is_inactive = false, updated_at = now()
       where folder_id in (${descendants}) and org_id = ${orgId}
    `)

    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'folders',
      rowId: id,
      action: 'restore',
      changes: {
        before: { folders: beforeFolders.rows, files: beforeFiles.rows },
        after: {
          folders: beforeFolders.rows.map(({ id: folderId }) => ({ id: folderId, isInactive: false })),
          files: beforeFiles.rows.map(({ id: fileId }) => ({ id: fileId, isInactive: false })),
        },
      },
      executor: tx,
    })
    return true
  })
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

    const s3Versions = (await tx.execute<{ id: string }>(sql`
      select fv.id from file_versions fv
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
        changes: { permanent: true },
        executor: tx,
      })
    }
    return { ok: true as const, s3VersionIds: s3Versions.rows.map((v) => v.id) }
  })
  if (!outcome.ok) return outcome
  await deleteS3Blobs(outcome.s3VersionIds)
  return { ok: true }
}

// --- trash ------------------------------------------------------------------

export interface TrashItem {
  kind: 'folder' | 'file'
  id: string
  name: string
  fileType: string | null
  folderName: string | null
  updatedAt: string
}

/**
 * Trashed items for the recycle bin — the TOP of each trashed subtree only
 * (a folder trashed with its contents shows once; a file trashed on its own
 * shows once). Respects private-folder + grant visibility.
 */
export async function listTrash(orgId: string, viewer: FileViewer): Promise<TrashItem[]> {
  const scope = await resolveReadScope(orgId, viewer)
  const [folders, files] = await Promise.all([
    db.execute(sql`
      select f.id, f.name, f.updated_at as "updatedAt"
        from folders f
        left join folders p on p.id = f.parent_folder_id and p.org_id = f.org_id
       where f.org_id = ${orgId} and f.is_inactive and not f.is_system
         and (p.id is null or not p.is_inactive)
         and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
       order by f.updated_at desc`),
    db.execute(sql`
      select fi.id, fi.name, fi.file_type as "fileType", fo.name as "folderName", fi.updated_at as "updatedAt"
        from files fi
        left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
       where fi.org_id = ${orgId} and fi.is_inactive
         and (fo.id is null or not fo.is_inactive)
         and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
       order by fi.updated_at desc`),
  ])
  const folderRows = folders.rows as unknown as Array<{ id: string; name: string; updatedAt: string }>
  const fileRows = files.rows as unknown as Array<{
    id: string; name: string; fileType: string | null; folderName: string | null; updatedAt: string
  }>
  return [
    ...folderRows.map((f) => ({
      kind: 'folder' as const,
      id: f.id,
      name: f.name,
      fileType: null,
      folderName: null,
      updatedAt: f.updatedAt,
    })),
    ...fileRows.map((f) => ({
      kind: 'file' as const,
      id: f.id,
      name: f.name,
      fileType: f.fileType,
      folderName: f.folderName,
      updatedAt: f.updatedAt,
    })),
  ]
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

  const scope = await resolveReadScope(orgId, viewer)
  const whereParts = [
    sql`fi.org_id = ${orgId}`,
    sql`not fi.is_inactive`,
    visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`),
  ]
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
    db.execute(sql`select count(*) as n from files fi where ${where}`),
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
  const rowParentVisible = visibleFolderPredicate(scope.hiddenFolderIds, sql`f.parent_folder_id`)
  const childVisible = visibleFolderPredicate(scope.hiddenFolderIds, sql`c.id`)

  // Folder count first — it anchors the combined pagination math.
  const folderCount = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from folders f
     where f.org_id = ${orgId} and not f.is_inactive and ${parentPred}
       and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
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
                   where fi.folder_id = f.id and fi.org_id = ${orgId} and not fi.is_inactive) as "fileCount"
            from folders f
           where f.org_id = ${orgId} and not f.is_inactive and ${parentPred}
             and ${visibleFolderPredicate(scope.hiddenFolderIds, sql`f.id`)}
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
  const meta = (await db.execute(sql`
    select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
           fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
           fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
           fi.created_at as "createdAt", fi.created_by as "createdBy",
           fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
           fo.name as "folderName"
      from files fi
      left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
     where fi.id = ${id} and fi.org_id = ${orgId}
       and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
  `))
  if (meta.rows.length === 0) return null
  const f = meta.rows[0]

  const [versions, attachments] = await Promise.all([
    db.execute(sql`
      select fv.id, fv.version_number as "versionNumber", fv.size_bytes as "sizeBytes",
             fv.content_type as "contentType", fv.content_hash as "contentHash",
             fv.created_at as "createdAt", fv.created_by as "createdBy"
        from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${orgId}
       where fv.file_id = ${id}
       order by fv.version_number desc
    `),
    db.execute(sql`
      select id, target_table as "targetTable", target_id as "targetId",
             created_at as "createdAt"
        from file_attachments where file_id = ${id} and org_id = ${orgId}
        order by created_at desc
    `),
  ])
  const versionCount = (versions).rows.length
  return {
    ...f,
    versionCount,
    versions: versions.rows as unknown as FileVersion[],
    attachments: attachments.rows as unknown as FileAttachmentLink[],
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
  return inDbTransaction(async (tx) => {
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
    // Object-store put happens inside the transaction: an upload failure rolls
    // the metadata back; a commit failure at worst orphans one unreferenced
    // object (never metadata without bytes).
    if (kind === 's3') await putS3Blob(versionId, input.bytes, input.contentType)
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
        changes: { name: input.filename, folderId: input.folderId },
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
    const contentHash = createHash('sha256').update(input.bytes).digest('hex')
    const current = (await tx.execute<{ vid: string | null; max_ver: number | null }>(sql`
      select current_version_id as vid, (
        select max(fv.version_number) from file_versions fv
        join files fi on fi.id = fv.file_id and fi.org_id = ${input.orgId}
        where fv.file_id = ${input.fileId}
      ) as max_ver
        from files where id = ${input.fileId} and org_id = ${input.orgId}
          and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${input.orgId})
        for update
    `))
    if (current.rows.length === 0) return false
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
    return true
  })
}

/**
 * Attribution for a mutating verb's audit evidence. When passed, the verb
 * commits the mutation and its attributable before/after evidence in ONE
 * inDbTransaction unit — a failed audit insert rolls the mutation back
 * (fail-closed). When omitted, the verb keeps its legacy single-statement
 * behaviour for callers that record their own evidence.
 */
export interface FileMutationAudit {
  actorId: string | null
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
  return inDbTransaction(async (tx) => {
    const prev = (await tx.execute<{ id: string; name: string }>(sql`
      select id, name from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
      for update
    `))
    if (prev.rows.length === 0) return false
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
  })
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
  return inDbTransaction(async (tx) => {
    const prev = (await tx.execute<{ id: string; folderId: string }>(sql`
      select id, folder_id as "folderId" from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
        and exists (select 1 from folders fo where fo.id = ${folderId} and fo.org_id = ${orgId})
      for update
    `))
    if (prev.rows.length === 0) return false
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
      changes: { fromFolderId: prev.rows[0]!.folderId, toFolderId: folderId },
      executor: tx,
    })
    return true
  })
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
      returning id
    `))
    return r.rows.length > 0
  }
  if (!audit) return trash(db)
  return inDbTransaction(async (tx) => {
    if (!(await trash(tx))) return false
    await recordFileEvent({
      orgId,
      actorId: audit.actorId,
      table: 'files',
      rowId: id,
      action: 'delete',
      changes: { permanent: false },
      executor: tx,
    })
    return true
  })
}

/** Restore a trashed file. */
export async function restoreFile(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute<{ id: string }>(sql`
    update files set is_inactive = false, updated_at = now()
     where id = ${id} and org_id = ${orgId} and is_inactive
    returning id
  `))
  return r.rows.length > 0
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
export async function purgeFile(
  orgId: string,
  id: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  const deleted = await inDbTransaction(async (tx) => {
    const owned = (await tx.execute<{ id: string }>(sql`
      select id from files where id = ${id} and org_id = ${orgId}
        and not exists (select 1 from ap_capture_items ci where ci.file_id = files.id and ci.org_id = ${orgId})
      for update
    `))
    if (owned.rows.length === 0) return null
    const material = (await tx.execute(sql`
      select fa.id
        from file_attachments fa
       where fa.file_id = ${id} and fa.org_id = ${orgId}
         and (
           (fa.target_table = 'documents' and exists (
             select 1 from documents d
              where d.id = fa.target_id and d.org_id = fa.org_id and d.status = 'posted'))
           or (fa.target_table = 'compliance_records' and exists (
             select 1 from compliance_records cr
              where cr.id = fa.target_id and cr.org_id = fa.org_id and cr.status <> 'superseded'))
           or (fa.target_table = 'fixed_assets' and exists (
             select 1 from fixed_assets a
              where a.id = fa.target_id and a.org_id = fa.org_id))
         )
       limit 1
    `))
    if (material.rows.length > 0) return null
    const s3Versions = (await tx.execute<{ id: string }>(sql`
      select fv.id from file_versions fv
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
     where fi.id = ${id} and fi.org_id = ${orgId}
       and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
  `))
  if (r.rows.length === 0) return null
  const row = r.rows[0]!
  const bytes = row.storageKind === 's3' ? await getS3Blob(row.versionId) : row.bytes
  if (!bytes) return null
  // The resolved version id is an immutable validator: a file_versions row's
  // bytes never change (append-only versioning), so it doubles as a strong ETag.
  return { filename: row.name, contentType: row.contentType, bytes, versionId: row.versionId }
}

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
  const attIns = (await db.execute<{ id: string }>(sql`
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
}

/** Attach an existing file to a record (no upload). Idempotent. */
export async function attachExisting(input: {
  orgId: string
  fileId: string
  targetTable: string
  targetId: string
  createdBy: string
}): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${input.orgId}, ${input.fileId}, ${input.targetTable}, ${input.targetId},
            ${input.createdBy}, now())
    on conflict (org_id, file_id, target_table, target_id) do nothing
    returning id
  `))
  return r.rows[0]?.id ?? null
}

/** Detach a file from a record (does NOT delete the file). */
export async function detachAttachment(orgId: string, attachmentId: string): Promise<boolean> {
  const r = (await db.execute<{ id: string }>(sql`
    delete from file_attachments where id = ${attachmentId} and org_id = ${orgId} returning id
  `))
  return r.rows.length > 0
}

/** Get the target table for an attachment link (for permission gating). */
export async function getAttachmentTarget(
  orgId: string,
  attachmentId: string,
): Promise<string | null> {
  const r = (await db.execute<{ target_table: string }>(sql`
    select target_table from file_attachments where id = ${attachmentId} and org_id = ${orgId}
  `))
  return r.rows[0]?.target_table ?? null
}
