import 'server-only'

import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { claimSetupCreate } from '../api/idempotency'
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
  options: {
    id?: string
    source?: 'import'
    dryRun?: boolean
    /**
     * Idempotent-create support (POST /api/admin/setup/[entity] only): the
     * caller's Idempotency-Key becomes the new row's id, and the insert audit
     * carries it as request_id with the request-controlled `match` image so a
     * retried request replays instead of duplicating. The claim resolves at
     * the top of this function, before the demotion below, so a replay never
     * re-demotes the other books. Import and single-purpose routes omit both
     * and keep the historical behavior byte-for-byte (database-assigned id,
     * no request image).
     */
    idempotencyKey?: string
    match?: Record<string, unknown>
  } = {},
): Promise<string | null> {
  if (!isSetupBookEntity(entity)) throw new Error('unsupported book entity')
  const accounting = entity.key === 'accounting-books'
  const flag = accounting ? 'is_primary' : 'is_default'
  const field = accounting ? 'isPrimary' : 'isDefault'
  const table = sql.identifier(entity.table)
  const source = options.source ? { source: options.source } : {}
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${entity.key}:${orgId}`}, 0))`)
  // The idempotent claim resolves BEFORE any create effect below (demotion,
  // insert, audit), so an exact retry returns here having written nothing.
  // The caller's transaction already holds the key's advisory lock ahead of
  // this fence, serializing concurrent retries of the same key.
  if (!options.id && options.idempotencyKey) {
    const claim = await claimSetupCreate(tx, {
      orgId, table: entity.table, key: options.idempotencyKey,
      match: options.match ?? {}, orgScoped: entity.orgScoped,
    })
    if (claim.kind === 'replay') return claim.id
  }
  if (accounting) {
    // First-history journal inserts retain the primary row before the FK
    // checks their explicit (possibly secondary) book. Match that order even
    // when the requested edit targets a secondary book being promoted.
    await tx.execute(sql`select id from accounting_books
      where org_id = ${orgId} and is_primary order by id for update`)
  }


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
  if (selected) {
    const scope = sql`org_id = ${orgId} and ${sql.identifier(flag)}
      ${options.id ? sql`and id <> ${options.id}` : sql``}`
    const prior = (await tx.execute<Record<string, unknown>>(sql`
      select * from ${table} where ${scope} order by id for update`)).rows
    if (accounting && prior.length) {
      const history = (await tx.execute(sql`
        select id from journal_entries where org_id=${orgId}
        union all select id from reconciliations where org_id=${orgId} limit 1`)).rows[0]
      if (history) throw new Error('Cannot reassign the primary book while journal entries or bank reconciliation sessions/history exist; a controlled book conversion is required')
    }
    const priorById = new Map(prior.map(row => [String(row.id), row]))
    if (prior.length && !options.dryRun) {
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
  if (options.dryRun) return options.id ?? null

  const idempotentCreate = !before && options.idempotencyKey !== undefined
  const createId = idempotentCreate ? sql`id, ` : sql``
  const createIdValue = idempotentCreate ? sql`${options.idempotencyKey}, ` : sql``
  const createConflict = idempotentCreate ? sql`on conflict (id) do nothing ` : sql``
  const stored = before
    ? await tx.execute<Record<string, unknown>>(sql`
        update ${table} set name = ${String(body.name)}, ${sql.identifier(flag)} = ${selected},
          is_active = ${active}, updated_at = now(), updated_by = ${actorId}
          ${accounting ? sql`` : sql`, currency = ${currency}`}
         where id = ${options.id} and org_id = ${orgId} returning *`)
    : await tx.execute<Record<string, unknown>>(sql`
        insert into ${table} (${createId}org_id, code, name, ${sql.identifier(flag)}, is_active, created_by, updated_by
          ${accounting ? sql`` : sql`, currency`})
        values (${createIdValue}${orgId}, ${String(body.code)}, ${String(body.name)}, ${selected}, ${active}, ${actorId}, ${actorId}
          ${accounting ? sql`` : sql`, ${currency}`})
        ${createConflict}returning *`)
  let after = stored.rows[0]
  if (!after && idempotentCreate) {
    // Lost the same-key insert race: the winner's row (and its insert audit)
    // is visible now, so re-resolve the claim — replay, or refuse.
    const claim = await claimSetupCreate(tx, {
      orgId, table: entity.table, key: options.idempotencyKey!,
      match: options.match ?? {}, orgScoped: entity.orgScoped,
    })
    if (claim.kind === 'replay') return claim.id
    after = undefined
  }
  if (!after) throw new Error('not found')
  const id = String(after.id)
  // A write that matches zero rows is a failure, not a success: the explicit
  // id must be the row that was stored, otherwise a mis-scoped insert would
  // report success for a row no read can observe.
  if (!before && options.idempotencyKey && id !== options.idempotencyKey) throw new Error('not found')
  await audit({ orgId, table: entity.table, rowId: id, action: before ? 'update' : 'insert',
    changes: { ...source, ...(before ? { before } : options.source ? { before: null } : {}), after,
      ...(before || !options.idempotencyKey ? {} : { match: options.match ?? {} }) },
    actorId, ...(before || !options.idempotencyKey ? {} : { requestId: options.idempotencyKey }) }, tx)
  return id
}
