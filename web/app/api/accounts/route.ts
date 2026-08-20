import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ACCOUNT_TYPES } from '@openbooks/schema'
import { guardPermission } from '../../../lib/authz'
import { loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { isUuid } from '../../../lib/list-params'
import { loadAccount } from './_lib'

export const runtime = 'nodejs'

const CURRENCY_RE = /^[A-Z]{3}$/

interface CreateBody {
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
  monetary?: boolean | null
  requiredDimensions?: string[]
  custom?: Record<string, unknown>
}

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * Create one tenant-owned account.
 *
 * The caller supplies a UUID idempotency key, which becomes the account ID.
 * Retrying the same request therefore returns the same account without a
 * duplicate insert or duplicate audit event.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('gl.manage')
  if (gate instanceof NextResponse) return gate

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  const parsed = await request.json().catch(() => ({}))
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as CreateBody
    : {}

  const name = body.name?.trim() ?? ''
  if (!name) return bad('name_required', 'name')
  if (!body.type || !ACCOUNT_TYPES.includes(body.type as (typeof ACCOUNT_TYPES)[number])) {
    return bad('invalid_type', 'type')
  }

  const number = textOrNull(body.number)
  const description = textOrNull(body.description)
  const parentId = textOrNull(body.parentId)
  const isSummary = body.isSummary === true
  const isActive = body.isActive !== false
  const reconcilable = body.reconcilable === true
  if (isSummary && reconcilable) return bad('summary_reconcilable_conflict')

  if (parentId) {
    if (!isUuid(parentId)) return bad('invalid_parent', 'parentId')
    const parent = (await db.execute<{ is_summary: boolean; type: string }>(sql`
      select is_summary, type from accounts
       where id = ${parentId} and org_id = ${gate.user.orgId}
    `))
    if (!parent.rows[0]) return bad('invalid_parent', 'parentId')
    if (!parent.rows[0].is_summary) return bad('parent_must_be_summary', 'parentId')
    if (parent.rows[0].type !== body.type) return bad('parent_type_mismatch', 'parentId')
  }

  const currencyRestriction = textOrNull(body.currencyRestriction)?.toUpperCase() ?? null
  if (currencyRestriction) {
    if (!CURRENCY_RE.test(currencyRestriction)) return bad('invalid_currency', 'currencyRestriction')
    const currency = (await db.execute(sql`
      select 1 from currencies where code = ${currencyRestriction}
    `))
    if (!currency.rows[0]) return bad('invalid_currency', 'currencyRestriction')
  }

  const subsidiaryId = textOrNull(body.subsidiaryId)
  if (subsidiaryId) {
    if (!isUuid(subsidiaryId)) return bad('invalid_subsidiary', 'subsidiaryId')
    const subsidiary = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${subsidiaryId} and org_id = ${gate.user.orgId}
    `))
    if (!subsidiary.rows[0]) return bad('invalid_subsidiary', 'subsidiaryId')
  }

  const definitions = (await db.execute<{ key: string }>(sql`
    select key from segment_definitions
     where org_id = ${gate.user.orgId} and is_active and allow_account_requirement
  `))
  const allowedDimensions = new Set(['party', ...definitions.rows.map((row) => row.key)])
  const requestedDimensions = body.requiredDimensions ?? []
  if (
    !Array.isArray(requestedDimensions)
    || requestedDimensions.some((dimension) => typeof dimension !== 'string' || !allowedDimensions.has(dimension))
  ) {
    return bad('invalid_dimensions', 'requiredDimensions')
  }
  const requiredDimensions = [...new Set(requestedDimensions)]

  const validatedCustom = validateCustomValues(await loadFieldDefs('accounts'), body.custom ?? {})
  if (!validatedCustom.ok) return bad('invalid_custom_fields', 'custom')
  const custom = validatedCustom.cleaned

  const snapshot = {
    id: requestId,
    org_id: gate.user.orgId,
    number,
    name,
    type: body.type,
    description,
    parent_id: parentId,
    is_summary: isSummary,
    is_active: isActive,
    currency_restriction: currencyRestriction,
    eliminate: body.eliminate === true,
    subsidiary_id: subsidiaryId,
    subsidiary_include_children: body.subsidiaryIncludeChildren !== false,
    reconcilable,
    monetary: typeof body.monetary === 'boolean' ? body.monetary : null,
    required_dimensions: requiredDimensions,
    custom,
  }

  let created = false
  try {
    created = await db.transaction(async (tx) => {
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into accounts
          (id, org_id, number, name, type, description, parent_id, is_summary, is_active,
           currency_restriction, eliminate, subsidiary_id, subsidiary_include_children,
           reconcilable, monetary, required_dimensions, custom, created_by, updated_by)
        values
          (${requestId}, ${gate.user.orgId}, ${number}, ${name}, ${body.type}, ${description},
           ${parentId}, ${isSummary}, ${isActive}, ${currencyRestriction}, ${body.eliminate === true},
           ${subsidiaryId}, ${body.subsidiaryIncludeChildren !== false}, ${reconcilable},
           ${typeof body.monetary === 'boolean' ? body.monetary : null},
           ${JSON.stringify(requiredDimensions)}::jsonb, ${JSON.stringify(custom)}::jsonb,
           ${gate.user.id}, ${gate.user.id})
        on conflict (id) do nothing
        returning id
      `))
      if (!inserted.rows[0]) {
        const prior = (await tx.execute<{ id: string }>(sql`
          select id from accounts
           where id = ${requestId} and org_id = ${gate.user.orgId}
        `))
        if (!prior.rows[0]) throw new Error('idempotency_key_conflict')
        return false
      }
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${gate.user.orgId}, 'accounts', ${requestId}, 'insert',
           ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
           ${gate.user.id}, ${requestId})
      `)
      return true
    })
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('accounts_org_number')) return bad('number_in_use', 'number')
    if (message.includes('idempotency_key_conflict')) return bad('invalid_idempotency_key', undefined, 409)
    throw error
  }

  const payload = await loadAccount(requestId, gate.user.orgId)
  if (!payload) return bad('save_failed', undefined, 500)
  return NextResponse.json(payload, { status: created ? 201 : 200 })
}
