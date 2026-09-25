/** Split from web/lib/file-cabinet.ts (ARCH-FILE-SPLIT; pure moves only). */
import 'server-only'
import { type FileViewer } from './types'
import { resolveReadScope, visibleFolderPredicate, visibleFilePredicate, recordScopeFilePredicate, recordScopeFolderPredicate } from './visibility'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

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
         and ${recordScopeFolderPredicate(orgId, viewer, sql`f.id`)}
       order by f.updated_at desc`),
    db.execute(sql`
      select fi.id, fi.name, fi.file_type as "fileType", fo.name as "folderName", fi.updated_at as "updatedAt"
        from files fi
        left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
       where fi.org_id = ${orgId} and fi.is_inactive
         and (fo.id is null or not fo.is_inactive)
         and ${visibleFilePredicate(scope, sql`fi.folder_id`, sql`fi.id`)}
         and ${recordScopeFolderPredicate(orgId, viewer, sql`fo.id`)}
         and ${recordScopeFilePredicate(orgId, viewer.allowedSubsidiaryIds, sql`fi.id`, sql`fo.record_table`, sql`fo.record_id`)}
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
