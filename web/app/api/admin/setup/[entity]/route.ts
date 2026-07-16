import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { SETUP_ENTITY_BY_KEY, toSnake, type SetupEntity } from '../../../../../lib/setup/registry'
import {
  buildRow,
  describeDbError,
  idColumn,
  multirefField,
  UUID_RE,
} from '../../../../../lib/setup/coerce'

export const runtime = 'nodejs'

/**
 * Generic CRUD for every configuration entity in the Setup registry
 * (web/lib/setup/registry.ts). One route serves all of them — the entity slug
 * in the path selects the descriptor, which drives column whitelisting,
 * validation, and the SQL.
 *
 * SECURITY: table and column identifiers are taken ONLY from the registry
 * (never from the request body) and interpolated with sql.raw; every value is a
 * bound parameter. The request body cannot introduce a column name.
 *
 * Gated by admin.setup.manage. Org-scoped (except the shared `currencies`
 * reference table) and audited to audit_log, mirroring the settings route.
 */

const PERMISSION = 'admin.setup.manage'

async function audit(args: {
  orgId: string | null
  table: string
  rowId: string
  action: 'insert' | 'update' | 'delete'
  changes: Record<string, unknown>
  actorId: string
}) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`)
}

/** Reconcile a tax group's members join table to exactly `taxCodeIds`. */
async function syncMembers(groupId: string, taxCodeIds: string[]) {
  const clean = [...new Set(taxCodeIds.filter((v) => UUID_RE.test(v)))]
  await db.execute(sql`delete from tax_group_members where tax_group_id = ${groupId}`)
  for (let i = 0; i < clean.length; i++) {
    await db.execute(sql`
      insert into tax_group_members (tax_group_id, tax_code_id, sequence)
      values (${groupId}, ${clean[i]}, ${i + 1})`)
  }
}

function resolveEntity(entityKey: string): SetupEntity | null {
  return SETUP_ENTITY_BY_KEY.get(entityKey) ?? null
}

export async function POST(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const built = buildRow(entity, body, { forCreate: true })
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })

  // Natural-key uniqueness (these tables mostly lack a DB unique constraint).
  if (entity.naturalKey) {
    const col = toSnake(entity.naturalKey)
    const val = String(body[entity.naturalKey] ?? '')
    const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
    const dup = (await db.execute(sql`
      select 1 from ${sql.raw(entity.table)}
       where ${sql.raw(col)} = ${val}${orgFilter} limit 1`)) as any
    if (dup.rows.length > 0) return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
  }

  const cols = [...built.cols]
  if (entity.orgScoped) cols.push({ column: 'org_id', value: orgId })
  if (entity.actorCols) {
    cols.push({ column: 'created_by', value: actorId })
    cols.push({ column: 'updated_by', value: actorId })
  }

  const colSql = sql.raw(cols.map((c) => c.column).join(', '))
  const valSql = sql.join(
    cols.map((c) => sql`${c.value}`),
    sql`, `,
  )

  try {
    const inserted = (await db.execute(sql`
      insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
      returning ${sql.raw(idColumn(entity))} as id`)) as any
    const newId = inserted.rows[0]?.id as string

    const members = multirefField(entity)
    if (members && Array.isArray(body[members.key])) {
      await syncMembers(newId, (body[members.key] as unknown[]).map(String))
    }
    await audit({
      orgId: entity.orgScoped ? orgId : null,
      table: entity.table,
      rowId: String(newId),
      action: 'insert',
      changes: Object.fromEntries(built.cols.map((c) => [c.column, c.value])),
      actorId,
    })
    return NextResponse.json({ id: newId })
  } catch (e) {
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const built = buildRow(entity, body, { forCreate: false })
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })

  const setParts = built.cols.map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
  if (entity.actorCols) {
    setParts.push(sql`updated_by = ${actorId}`)
    setParts.push(sql`updated_at = now()`)
  }
  if (setParts.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
  try {
    const updated = (await db.execute(sql`
      update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
       where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
      returning ${sql.raw(idColumn(entity))} as id`)) as any
    if (updated.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const members = multirefField(entity)
    if (members && Array.isArray(body[members.key])) {
      await syncMembers(id, (body[members.key] as unknown[]).map(String))
    }
    await audit({
      orgId: entity.orgScoped ? orgId : null,
      table: entity.table,
      rowId: id,
      action: 'update',
      changes: Object.fromEntries(built.cols.map((c) => [c.column, c.value])),
      actorId,
    })
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })

  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
  try {
    const deleted = (await db.execute(sql`
      delete from ${sql.raw(entity.table)}
       where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
      returning ${sql.raw(idColumn(entity))} as id`)) as any
    if (deleted.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })
    await audit({
      orgId: entity.orgScoped ? orgId : null,
      table: entity.table,
      rowId: id,
      action: 'delete',
      changes: {},
      actorId,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Foreign-key violation → the record is referenced elsewhere.
    if ((e as { code?: string })?.code === '23503') {
      return NextResponse.json({ error: 'in-use', code: 'in-use' }, { status: 409 })
    }
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}
