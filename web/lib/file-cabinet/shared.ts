/** Split from web/lib/file-cabinet.ts; moved without behavior changes. */
import 'server-only'
import { type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { enqueueStorageCleanup, fileCabinetObjectKey } from '../file-storage'

export async function enqueueCabinetCleanup(
  tx: SqlExecutor,
  orgId: string,
  versions: { id: string; file_id: string }[],
): Promise<void> {
  for (const version of versions) {
    await enqueueStorageCleanup(tx, {
      orgId,
      objectKey: fileCabinetObjectKey(version.id),
      ownerKind: 'file_version',
      ownerId: version.file_id,
    })
  }
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

export function deriveFileType(contentType: string): string {
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType === 'text/csv') return 'csv'
  if (contentType.includes('spreadsheet')) return 'spreadsheet'
  if (contentType.includes('wordprocessing')) return 'document'
  if (contentType.startsWith('text/')) return 'text'
  return 'other'
}
