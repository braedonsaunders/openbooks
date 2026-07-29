import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ACCOUNT_TYPES } from '@openbooks/schema'
import { guardPermission } from '../../../../lib/authz'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { loadAccount } from '../_lib'

export const runtime = 'nodejs'

const CURRENCY_RE = /^[A-Z]{3}$/

interface PatchBody {
  number?: string | null
  name?: string
  type?: string
  description?: string | null
  parentId?: string | null
  isSummary?: boolean
  isActive?: boolean
  currencyRestriction?: string | null
  eliminate?: boolean
  subsidiaryId?: string | null
  subsidiaryIncludeChildren?: boolean
  reconcilable?: boolean
  requiredDimensions?: string[]
  custom?: Record<string, unknown>
}

function bad(error: string, field?: string) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status: 422 })
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

async function belongsToOrg(table: 'accounts' | 'subsidiaries', id: string, orgId: string) {
  const result = (await db.execute(sql`
    select 1 from ${sql.raw(table)} where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: unknown[] }
  return Boolean(result.rows[0])
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const payload = await loadAccount(id, gate.user.orgId)
  return payload
    ? NextResponse.json(payload)
    : NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const existingPayload = await loadAccount(id, gate.user.orgId)
  if (!existingPayload) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const existing = existingPayload.account as Record<string, any>
  const parsed = await request.json().catch(() => ({}))
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PatchBody : {}

  const name = body.name === undefined ? undefined : body.name.trim()
  if (name !== undefined && !name) return bad('name_required', 'name')
  if (body.type !== undefined && !ACCOUNT_TYPES.includes(body.type as (typeof ACCOUNT_TYPES)[number])) {
    return bad('invalid_type', 'type')
  }
  if (body.type !== undefined && body.type !== existing.type && existingPayload.hasTransactions) {
    return bad('type_has_transactions', 'type')
  }
  const nextType = body.type ?? String(existing.type)

  let parentId: string | null | undefined
  if (body.parentId !== undefined) {
    parentId = textOrNull(body.parentId)
    if (parentId) {
      if (!isUuid(parentId) || parentId === id) return bad('invalid_parent', 'parentId')
      const parent = (await db.execute(sql`
        select is_summary, type from accounts
         where id = ${parentId} and org_id = ${gate.user.orgId}
      `)) as unknown as { rows: { is_summary: boolean; type: string }[] }
      if (!parent.rows[0]?.is_summary) return bad('parent_must_be_summary', 'parentId')
      if (parent.rows[0].type !== nextType) return bad('parent_type_mismatch', 'parentId')
      const cycle = (await db.execute(sql`
        with recursive descendants as (
          select id from accounts where id = ${id} and org_id = ${gate.user.orgId}
          union
          select child.id from accounts child
          join descendants d on child.parent_id = d.id
          where child.org_id = ${gate.user.orgId}
        )
        select 1 from descendants where id = ${parentId} limit 1
      `)) as unknown as { rows: unknown[] }
      if (cycle.rows[0]) return bad('parent_cycle', 'parentId')
    }
  }
  const effectiveParentId = parentId !== undefined ? parentId : (existing.parent_id as string | null)
  if (effectiveParentId && body.type !== undefined && body.parentId === undefined) {
    const parent = (await db.execute(sql`
      select type from accounts
       where id = ${effectiveParentId} and org_id = ${gate.user.orgId}
    `)) as unknown as { rows: { type: string }[] }
    if (!parent.rows[0] || parent.rows[0].type !== nextType) {
      return bad('parent_type_mismatch', 'type')
    }
  }

  const nextSummary = body.isSummary ?? Boolean(existing.is_summary)
  const nextReconcilable = body.reconcilable ?? Boolean(existing.reconcilable)
  if (nextSummary && nextReconcilable) return bad('summary_reconcilable_conflict')
  if (body.isSummary === true && existingPayload.hasTransactions) return bad('summary_has_transactions', 'isSummary')
  if (body.isSummary === false && existingPayload.childCount > 0) return bad('summary_has_children', 'isSummary')
  if (body.isActive === false && existingPayload.activeChildCount > 0) return bad('inactive_has_children', 'isActive')

  let currencyRestriction: string | null | undefined
  if (body.currencyRestriction !== undefined) {
    currencyRestriction = textOrNull(body.currencyRestriction)?.toUpperCase() ?? null
    if (currencyRestriction && !CURRENCY_RE.test(currencyRestriction)) {
      return bad('invalid_currency', 'currencyRestriction')
    }
    if (currencyRestriction) {
      const currency = (await db.execute(sql`select 1 from currencies where code = ${currencyRestriction}`)) as unknown as {
        rows: unknown[]
      }
      if (!currency.rows[0]) return bad('invalid_currency', 'currencyRestriction')
    }
  }

  let subsidiaryId: string | null | undefined
  if (body.subsidiaryId !== undefined) {
    subsidiaryId = textOrNull(body.subsidiaryId)
    if (subsidiaryId && (!isUuid(subsidiaryId) || !(await belongsToOrg('subsidiaries', subsidiaryId, gate.user.orgId)))) {
      return bad('invalid_subsidiary', 'subsidiaryId')
    }
  }

  let requiredDimensions: string[] | undefined
  if (body.requiredDimensions !== undefined) {
    const definitions = (await db.execute(sql`
      select key from segment_definitions
       where org_id = ${gate.user.orgId} and is_active and allow_account_requirement
    `)) as unknown as { rows: { key: string }[] }
    const allowed = new Set(['party', ...definitions.rows.map((row) => row.key)])
    if (!Array.isArray(body.requiredDimensions) || body.requiredDimensions.some((d) => typeof d !== 'string' || !allowed.has(d))) {
      return bad('invalid_dimensions', 'requiredDimensions')
    }
    requiredDimensions = [...new Set(body.requiredDimensions)]
  }

  let custom: Record<string, unknown> | undefined
  if (body.custom !== undefined) {
    const validated = validateCustomValues(await loadFieldDefs('accounts'), body.custom)
    if (!validated.ok) return bad('invalid_custom_fields', 'custom')
    custom = validated.cleaned
  }

  try {
    await db.transaction(async (tx) => {
      const updated = (await tx.execute(sql`
        update accounts set
          number = ${body.number !== undefined ? textOrNull(body.number) : sql`number`},
          name = ${name !== undefined ? name : sql`name`},
          type = ${body.type !== undefined ? body.type : sql`type`},
          description = ${body.description !== undefined ? textOrNull(body.description) : sql`description`},
          parent_id = ${parentId !== undefined ? parentId : sql`parent_id`},
          is_summary = ${body.isSummary !== undefined ? body.isSummary : sql`is_summary`},
          is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
          currency_restriction = ${currencyRestriction !== undefined ? currencyRestriction : sql`currency_restriction`},
          eliminate = ${body.eliminate !== undefined ? body.eliminate : sql`eliminate`},
          subsidiary_id = ${subsidiaryId !== undefined ? subsidiaryId : sql`subsidiary_id`},
          subsidiary_include_children = ${body.subsidiaryIncludeChildren !== undefined ? body.subsidiaryIncludeChildren : sql`subsidiary_include_children`},
          reconcilable = ${body.reconcilable !== undefined ? body.reconcilable : sql`reconcilable`},
          required_dimensions = ${requiredDimensions !== undefined ? JSON.stringify(requiredDimensions) : sql`required_dimensions`}::jsonb,
          custom = ${custom !== undefined ? JSON.stringify(custom) : sql`custom`}::jsonb,
          updated_at = now(), updated_by = ${gate.user.id}
         where id = ${id} and org_id = ${gate.user.orgId}
           and updated_at = ${existing.updated_at}
         returning *
      `)) as unknown as { rows: Record<string, unknown>[] }
      if (!updated.rows[0]) throw new Error('account_changed')
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${gate.user.orgId}, 'accounts', ${id}, 'update',
           ${JSON.stringify({ before: existing, after: updated.rows[0] })}::jsonb,
           ${gate.user.id}, ${request.headers.get('X-Request-Id')})
      `)
    })
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
    if (message.includes('accounts_org_number')) return bad('number_in_use', 'number')
    if (message.includes('account_changed')) {
      return NextResponse.json({ error: 'account_changed' }, { status: 409 })
    }
    throw error
  }

  return NextResponse.json(await loadAccount(id, gate.user.orgId))
}
