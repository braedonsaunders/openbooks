/** Split from web/lib/file-cabinet.ts; moved without behavior changes. */
import 'server-only'
import { type FileViewer, type AccessLevel, accessAtLeast } from './types'
import { folderAccessLevel, fileAccessLevel } from './visibility'
import { sql } from 'drizzle-orm'
import { inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

/**
 * Attribution for a mutating verb's audit evidence. When passed, the verb
 * commits the mutation and its attributable before/after evidence in ONE
 * inDbTransaction unit — a failed audit insert rolls the mutation back
 * (fail-closed). When omitted, the verb keeps its legacy single-statement
 * behaviour for callers that record their own evidence.
 */
export interface FileMutationAudit {
  actorId: string | null
  /** Participate in a caller-owned transaction (bulk units and replacements). */
  executor?: SqlExecutor
  /**
   * The caller as a FileViewer, for subsidiary-fence enforcement inside the
   * mutation's own transaction. When present the verb re-evaluates the
   * caller's tier on the transaction's snapshot and refuses (the same
   * not-found/false shape as a missing row) unless the verb's required tier
   * still holds — so a route-level gate cannot go stale between check and
   * write, and direct service callers cannot bypass the fence. Absent for
   * trusted internal callers (AP capture, tax PDFs) whose flows scope the
   * write themselves.
   */
  viewer?: FileViewer
  /** Recheck and lock an attachment target in the same transaction as its link mutation. */
  authorizeAttachmentTarget?: (
    executor: SqlExecutor,
    target: { targetTable: string; targetId: string },
  ) => Promise<void>
}

/**
 * In-transaction tier gates: re-evaluate the caller's access on `exec` (the
 * mutation's own snapshot) and report whether `min` still holds. No viewer —
 * no fence (trusted internal path).
 */
export async function viewerFileGate(
  exec: SqlExecutor,
  orgId: string,
  audit: FileMutationAudit | undefined,
  fileId: string,
  min: AccessLevel,
  options: { includeInactive?: boolean } = {},
): Promise<boolean> {
  if (!audit?.viewer) return true
  await lockCabinetAuthorization(exec, orgId)
  return accessAtLeast(await fileAccessLevel(orgId, audit.viewer, fileId, exec, options), min)
}

export async function viewerFolderGate(
  exec: SqlExecutor,
  orgId: string,
  audit: FileMutationAudit | undefined,
  folderId: string,
  min: AccessLevel,
  options: { includeInactive?: boolean } = {},
): Promise<boolean> {
  if (!audit?.viewer) return true
  await lockCabinetAuthorization(exec, orgId)
  return accessAtLeast(await folderAccessLevel(orgId, audit.viewer, folderId, exec, options), min)
}

/**
 * Serialize every viewer-authorized cabinet write with grant changes. One
 * org-scoped transaction lock is intentionally conservative: a grant revoke
 * either precedes the permission recheck or waits until the authorized write
 * commits, including inherited folder grants and previously absent rows.
 */
export async function lockCabinetAuthorization(exec: SqlExecutor, orgId: string): Promise<void> {
  await exec.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
    `file-cabinet-auth:${orgId}`
  }, 0))`)
}

export async function runMutation<T>(
  executor: SqlExecutor | undefined,
  work: (tx: SqlExecutor) => Promise<T>,
  authorizationOrgId?: string,
): Promise<T> {
  const run = async (tx: SqlExecutor) => {
    if (authorizationOrgId) await lockCabinetAuthorization(tx, authorizationOrgId)
    return work(tx)
  }
  if (executor) return run(executor)
  return inDbTransaction(run)
}
