import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/** Audited configuration writes for payment formats, profiles, schedules and mandates. */
export type ConfigTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function profileAuditView(row: Record<string, unknown>): Record<string, unknown> {
  const { originator_secrets_encrypted, originatorSecretsEncrypted, ...rest } = row;
  return {
    ...rest,
    hasOriginatorSecrets:
      originator_secrets_encrypted != null || originatorSecretsEncrypted != null,
  };
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
  `);
}
