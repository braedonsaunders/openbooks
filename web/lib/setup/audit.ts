import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * The Setup-registry generic audit writer — one format for every reference
 * entity, including rehomed surfaces that write outside the registry route.
 * Call inside the SAME transaction as the mutation; payloads follow the
 * accounts-route shape ({ after } on insert, { before, after } on update,
 * { before } on delete).
 */
export async function auditSetupChange(
  args: {
    orgId: string | null
    table: string
    rowId: string
    action: 'insert' | 'update' | 'delete'
    changes: Record<string, unknown>
    actorId: string
  },
  runner: Pick<typeof db, 'execute'> = db,
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`)
}
