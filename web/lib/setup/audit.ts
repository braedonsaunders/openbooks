import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { SetupEntity } from './registry'

/** Snapshot the actual stored setup row, including its ordered join-table
 * values. Call with lock=true before a mutation, on its transaction executor. */
export async function loadSetupAuditRow(
  entity: SetupEntity,
  orgId: string,
  rowId: string,
  runner: Pick<typeof db, 'execute'>,
  lock = false,
): Promise<Record<string, unknown> | undefined> {
  const row = (await runner.execute(sql`
    select * from ${sql.raw(entity.table)}
     where ${sql.raw(entity.idColumn ?? 'id')} = ${rowId}
       ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
       ${lock ? sql`for update` : sql``}
  `)).rows[0]
  if (!row) return undefined
  if (entity.key === 'tax-groups') {
    const members = await runner.execute<{ tax_code_id: string }>(sql`
      select tax_code_id from tax_group_members where tax_group_id = ${rowId}
       order by sequence, tax_code_id`)
    return { ...row, members: members.rows.map(member => member.tax_code_id) }
  }
  return row
}

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
