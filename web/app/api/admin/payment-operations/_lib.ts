import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Shared audit writer for the payment-operations config family (formats,
 * bank profiles, schedules, mandates). Rows are written inside the SAME
 * transaction as the mutation, mirroring accounts/[id]; payloads carry the
 * actor plus before/after state — sealed secrets appear only as presence flags.
 */

export type ConfigTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Strips sealed originator credentials, keeping only a presence flag. */
export function profileAuditView(row: Record<string, unknown>): Record<string, unknown> {
  const { originator_secrets_encrypted, originatorSecretsEncrypted, ...rest } = row
  return {
    ...rest,
    hasOriginatorSecrets: originator_secrets_encrypted != null || originatorSecretsEncrypted != null,
  }
}

export async function auditConfigChange(
  tx: ConfigTx,
  orgId: string,
  tableName: string,
  rowId: string,
  action: string,
  changes: unknown,
  actorId: string,
  requestId?: string | null,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values
      (${orgId}, ${tableName}, ${rowId}, ${action},
       ${JSON.stringify(changes)}::jsonb, ${actorId}, ${requestId ?? null})
  `)
}
