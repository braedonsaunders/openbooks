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
export { titleizeKind, deriveFileType } from '@openbooks/engine/src/platform/file-names.ts'
