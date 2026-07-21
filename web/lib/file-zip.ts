import 'server-only'
import JSZip from 'jszip'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getFileBlob, type FileViewer } from './file-cabinet'

/** Guardrails — zipping fetches every blob (often from object storage), so cap
 *  the work per request. Bulk selections and folder subtrees both go through
 *  these limits. */
export const MAX_ZIP_FILES = 300
export const MAX_ZIP_BYTES = 250 * 1024 * 1024 // 250 MB (uncompressed source)

export interface ZipEntry {
  id: string
  path: string
}

/**
 * File ids + archive-relative paths for a folder subtree (the folder, its
 * sub-folders, and their active files). One extra row over the cap is fetched
 * so callers can detect "too many".
 */
export async function folderZipManifest(orgId: string, folderId: string): Promise<ZipEntry[]> {
  const r = (await db.execute(sql`
    with recursive tree as (
      select id, name, parent_folder_id, name::text as prefix
        from folders where id = ${folderId} and org_id = ${orgId}
      union all
      select f.id, f.name, f.parent_folder_id, (t.prefix || '/' || f.name)
        from folders f join tree t on f.parent_folder_id = t.id and f.org_id = ${orgId}
       where not f.is_inactive
    )
    select fi.id, (t.prefix || '/' || fi.name) as path
      from files fi join tree t on t.id = fi.folder_id
     where fi.org_id = ${orgId} and not fi.is_inactive
     order by path
     limit ${MAX_ZIP_FILES + 1}
  `)) as unknown as { rows: ZipEntry[] }
  return r.rows
}

/** File ids + names for an explicit set of file ids (bulk selection). */
export async function filesZipManifest(orgId: string, fileIds: string[]): Promise<ZipEntry[]> {
  if (fileIds.length === 0) return []
  const r = (await db.execute(sql`
    select id, name as path from files
     where org_id = ${orgId} and not is_inactive
       and id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(fileIds)}::jsonb) as _f(value))
     order by name
     limit ${MAX_ZIP_FILES + 1}
  `)) as unknown as { rows: ZipEntry[] }
  return r.rows
}

/**
 * Build a zip from the given entries. Per-file visibility is enforced by
 * getFileBlob (invisible/unreadable files are skipped). De-duplicates archive
 * paths. Returns the zip bytes plus how many files were actually included.
 */
export async function buildZip(
  orgId: string,
  viewer: FileViewer,
  entries: ZipEntry[],
): Promise<{ bytes: Buffer; included: number }> {
  const zip = new JSZip()
  const used = new Set<string>()
  let included = 0
  for (const e of entries) {
    // A single unreadable blob (missing object, storage hiccup) must not sink
    // the whole archive — skip it.
    const blob = await getFileBlob(orgId, e.id, viewer).catch(() => null)
    if (!blob) continue
    let path = e.path
    if (used.has(path)) {
      const dot = path.lastIndexOf('.')
      const stem = dot > 0 ? path.slice(0, dot) : path
      const ext = dot > 0 ? path.slice(dot) : ''
      let n = 2
      while (used.has(`${stem} (${n})${ext}`)) n++
      path = `${stem} (${n})${ext}`
    }
    used.add(path)
    zip.file(path, blob.bytes)
    included++
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, included }
}
