import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { loadItem } from '../_lib'

export const runtime = 'nodejs'

const ITEM_KINDS = [
  'service',
  'non_inventory',
  'inventory',
  'assembly',
  'kit',
  'other_charge',
  'labor',
  'absence',
  'discount',
] as const

function bad(error: string, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, ...(fieldErrors ? { fieldErrors } : {}) }, { status: 422 })
}

/** Trimmed string or null ('' and non-strings collapse to null). */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

function uuidOrNull(v: unknown): string | null | 'invalid' {
  const s = strOrNull(v)
  if (s === null) return null
  return isUuid(s) ? s : 'invalid'
}

interface PatchBody {
  kind?: string
  code?: string | null
  name?: string
  category?: string | null
  unit?: string | null
  defaultRate?: string | null
  incomeAccountId?: string | null
  expenseAccountId?: string | null
  taxCodeId?: string | null
  showOnTimesheet?: boolean
  isActive?: boolean
  custom?: Record<string, unknown>
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const payload = await loadItem(id, gate.user.orgId)
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payload)
}

/**
 * Autosave for the item flyout: catalog fields, account/tax links, custom
 * values, and the explicit activate/deactivate action. Only provided fields
 * are updated; a real name is required to activate.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute(sql`
    select name, is_active from items where id = ${id} and org_id = ${user.orgId}
  `)) as unknown as { rows: { name: string; is_active: boolean }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody

  // -- kind ----------------------------------------------------------------
  if (body.kind !== undefined && !ITEM_KINDS.includes(body.kind as (typeof ITEM_KINDS)[number])) {
    return bad('Invalid item kind')
  }

  // -- name / activation ---------------------------------------------------
  const name = body.name !== undefined ? body.name.trim() : undefined
  const willBeActive = body.isActive ?? existing.rows[0].is_active
  const effectiveName = name ?? existing.rows[0].name.trim()
  if (willBeActive && (!effectiveName || effectiveName === 'New item')) {
    return bad(
      body.isActive === true ? 'Give the item a real name before activating it' : 'An active item needs a name',
    )
  }

  // -- default rate --------------------------------------------------------
  let defaultRate: string | null | undefined
  if (body.defaultRate !== undefined) {
    const raw = strOrNull(body.defaultRate)
    if (raw === null) defaultRate = null
    else {
      const n = Number(raw)
      if (Number.isNaN(n)) return bad('Default rate must be a number')
      defaultRate = n.toFixed(4)
    }
  }

  // -- account / tax references (must exist & belong to org) ---------------
  let incomeAccountId: string | null | undefined
  if (body.incomeAccountId !== undefined) {
    const v = uuidOrNull(body.incomeAccountId)
    if (v === 'invalid') return bad('Invalid income account')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from accounts where id = ${v} and org_id = ${user.orgId}`,
      )) as unknown as { rows: unknown[] }
      if (!r.rows[0]) return bad('Income account not found')
    }
    incomeAccountId = v
  }

  let expenseAccountId: string | null | undefined
  if (body.expenseAccountId !== undefined) {
    const v = uuidOrNull(body.expenseAccountId)
    if (v === 'invalid') return bad('Invalid expense account')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from accounts where id = ${v} and org_id = ${user.orgId}`,
      )) as unknown as { rows: unknown[] }
      if (!r.rows[0]) return bad('Expense account not found')
    }
    expenseAccountId = v
  }

  let taxCodeId: string | null | undefined
  if (body.taxCodeId !== undefined) {
    const v = uuidOrNull(body.taxCodeId)
    if (v === 'invalid') return bad('Invalid tax code')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from tax_codes where id = ${v} and org_id = ${user.orgId}`,
      )) as unknown as { rows: unknown[] }
      if (!r.rows[0]) return bad('Tax code not found')
    }
    taxCodeId = v
  }

  // -- custom fields -------------------------------------------------------
  let cleanedCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const defs = await loadFieldDefs('items')
    const v = validateCustomValues(defs, body.custom)
    if (!v.ok) return bad(Object.values(v.errors)[0]!, v.errors)
    cleanedCustom = v.cleaned
  }

  try {
    await db.execute(sql`
      update items set
        kind = coalesce(${body.kind ?? null}, kind),
        name = ${name !== undefined ? name : sql`name`},
        code = ${body.code !== undefined ? strOrNull(body.code) : sql`code`},
        category = ${body.category !== undefined ? strOrNull(body.category) : sql`category`},
        unit = ${body.unit !== undefined ? strOrNull(body.unit) : sql`unit`},
        default_rate = ${defaultRate !== undefined ? defaultRate : sql`default_rate`},
        income_account_id = ${incomeAccountId !== undefined ? incomeAccountId : sql`income_account_id`},
        expense_account_id = ${expenseAccountId !== undefined ? expenseAccountId : sql`expense_account_id`},
        tax_code_id = ${taxCodeId !== undefined ? taxCodeId : sql`tax_code_id`},
        show_on_timesheet = ${body.showOnTimesheet !== undefined ? body.showOnTimesheet : sql`show_on_timesheet`},
        is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
        custom = coalesce(${cleanedCustom ? JSON.stringify(cleanedCustom) : null}::jsonb, custom),
        updated_at = now(), updated_by = ${user.id}
      where id = ${id}
    `)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (msg.includes('items_org_code')) {
      return bad('Code already in use')
    }
    throw e
  }

  const payload = await loadItem(id, user.orgId)
  return NextResponse.json(payload)
}
