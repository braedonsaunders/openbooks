import 'server-only'

import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/src/db.ts'
import { auditSetupChange as audit } from './audit'
import { coerceBoolean } from './coerce'
import type { SetupEntity } from './registry'

export function isSetupBookEntity(entity: SetupEntity): boolean {
  return entity.key === 'accounting-books' || entity.key === 'item-rate-books'
}

/** Shared book lifecycle for interactive setup and imports. The caller owns
 * the tenant transaction and feature fence; this function then takes the book
 * fence before locking any rows. Every promotion and demotion shares its audit
 * transaction. Preview follows the same validation without changing rows. */
export async function saveSetupBook(
  entity: SetupEntity,
  orgId: string,
  actorId: string,
  body: Record<string, unknown>,
  tx: SqlExecutor,
  options: { id?: string; source?: 'import'; dryRun?: boolean } = {},
): Promise<string | null> {
  if (!isSetupBookEntity(entity)) throw new Error('unsupported book entity')
  const accounting = entity.key === 'accounting-books'
  const flag = accounting ? 'is_primary' : 'is_default'
  const field = accounting ? 'isPrimary' : 'isDefault'
  const table = sql.identifier(entity.table)
  const source = options.source ? { source: options.source } : {}
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${entity.key}:${orgId}`}, 0))`)

  const before = options.id
    ? (await tx.execute<Record<string, unknown>>(sql`
        select * from ${table} where id = ${options.id} and org_id = ${orgId} for update`)).rows[0]
    : undefined
  if (options.id && !before) throw new Error('not found')
  let selected = coerceBoolean(body[field])
  let active = coerceBoolean(body.isActive)
  if (before) {
    if (accounting) {
      if (before.is_primary && !selected) throw new Error('primary-required')
      if (selected && !active) throw new Error('primary-active-required')
    } else if ((before.is_default && !selected) || (selected && !active)) {
      throw new Error('default-required')
    }
  } else {
    const existing = (await tx.execute<{ selected: boolean }>(sql`
      select exists(select 1 from ${table} where org_id = ${orgId}
        and ${sql.identifier(flag)} ${accounting ? sql`` : sql`and is_active`}) as selected`)).rows[0]
    selected ||= !existing?.selected
    active = selected || body.isActive === undefined || coerceBoolean(body.isActive)
  }

  let currency: string | undefined
  if (!accounting) {
    if (body.currency !== undefined) currency = String(body.currency)
    else if (before) currency = String(before.currency)
    else {
      const org = (await tx.execute<{ base_currency: string }>(sql`
        select base_currency from orgs where id = ${orgId}`)).rows[0]
      if (!org) throw new Error('organization not found')
      currency = org.base_currency
    }
  }
  if (options.dryRun) return options.id ?? null

  if (selected) {
    const scope = sql`org_id = ${orgId} and ${sql.identifier(flag)}
      ${options.id ? sql`and id <> ${options.id}` : sql``}`
    const prior = (await tx.execute<Record<string, unknown>>(sql`
      select * from ${table} where ${scope} order by id for update`)).rows
    const priorById = new Map(prior.map(row => [String(row.id), row]))
    if (prior.length) {
      const demoted = (await tx.execute<Record<string, unknown>>(sql`
        update ${table} set ${sql.identifier(flag)} = false,
          updated_at = now(), updated_by = ${actorId} where ${scope} returning *`)).rows
      for (const after of demoted) {
        const previous = priorById.get(String(after.id))
        if (!previous) throw new Error('book reassignment is missing its prior state')
        await audit({ orgId, table: entity.table, rowId: String(after.id), action: 'update',
          changes: { ...source, before: previous, after,
            reason: accounting ? 'primary-book-reassigned' : 'default-rate-book-reassigned' }, actorId }, tx)
      }
    }
  }

  const stored = before
    ? await tx.execute<Record<string, unknown>>(sql`
        update ${table} set name = ${String(body.name)}, ${sql.identifier(flag)} = ${selected},
          is_active = ${active}, updated_at = now(), updated_by = ${actorId}
          ${accounting ? sql`` : sql`, currency = ${currency}`}
         where id = ${options.id} and org_id = ${orgId} returning *`)
    : await tx.execute<Record<string, unknown>>(sql`
        insert into ${table} (org_id, code, name, ${sql.identifier(flag)}, is_active, created_by, updated_by
          ${accounting ? sql`` : sql`, currency`})
        values (${orgId}, ${String(body.code)}, ${String(body.name)}, ${selected}, ${active}, ${actorId}, ${actorId}
          ${accounting ? sql`` : sql`, ${currency}`}) returning *`)
  const after = stored.rows[0]
  if (!after) throw new Error('not found')
  const id = String(after.id)
  await audit({ orgId, table: entity.table, rowId: id, action: before ? 'update' : 'insert',
    changes: { ...source, ...(before ? { before } : options.source ? { before: null } : {}), after }, actorId }, tx)
  return id
}
