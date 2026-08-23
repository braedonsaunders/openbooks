import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { loadItem } from '../_lib'
import { canonicalDecimal, compareDecimal, fixedDecimal } from '../../../../lib/exact-decimal'

export const runtime = 'nodejs'

const ITEM_KINDS = [
  'service',
  'non_inventory',
  'inventory',
  'assembly',
  'kit',
  'other_charge',
  'equipment_charge',
  'labor',
  'absence',
  'discount',
] as const

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

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
  description?: string | null
  category?: string | null
  unit?: string | null
  defaultRate?: string | null
  defaultCost?: string | null
  incomeAccountId?: string | null
  expenseAccountId?: string | null
  costRecoveryAccountId?: string | null
  taxCodeId?: string | null
  showOnTimesheet?: boolean
  isActive?: boolean
  custom?: Record<string, unknown>
  // Revenue recognition (ASC 606) item defaults.
  recognitionRuleId?: string | null
  deferredAccountId?: string | null
  createPlansOn?: string
  revenueAllocation?: string
  standaloneSellingPrice?: string | null
}

const CREATE_PLANS_ON = ['billing', 'fulfillment', 'arrangement'] as const
const REVENUE_ALLOCATION = ['normal', 'exclude', 'software'] as const
const REVENUE_RECOGNITION_BODY_KEYS = [
  'recognitionRuleId',
  'deferredAccountId',
  'createPlansOn',
  'revenueAllocation',
  'standaloneSellingPrice',
] as const

function bodyTouchesRevenueRecognition(body: PatchBody): boolean {
  return REVENUE_RECOGNITION_BODY_KEYS.some((key) => body[key] !== undefined)
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

  const existing = (await db.execute<{ name: string; is_active: boolean; kind: string }>(sql`
    select name, is_active, kind from items where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody
  if (bodyTouchesRevenueRecognition(body) && !(await isFeatureEnabled(user.orgId, 'revenueRecognition'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (body.showOnTimesheet !== undefined && !(await isFeatureEnabled(user.orgId, 'timeTracking'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // Inventory kinds (inventory / assembly / kit) are Inventory configuration.
  // Turning that switch off must refuse a new write; the stored kind stays.
  if (body.kind !== undefined && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
    const nextKind = String(body.kind)
    const storedKind = existing.rows[0].kind
    if (INVENTORY_ITEM_KINDS.has(nextKind) || (INVENTORY_ITEM_KINDS.has(storedKind) && nextKind !== storedKind)) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }
  // Equipment-charge kind is Equipment configuration.
  // Turning that switch off must refuse a new write; the stored kind stays.
  if (body.kind !== undefined && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
    const nextKind = String(body.kind)
    const storedKind = existing.rows[0].kind
    if (nextKind === 'equipment_charge' && nextKind !== storedKind) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }

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
      const exact = canonicalDecimal(raw, 4)
      if (exact === null) return bad('Default rate must be a number with no more than four decimal places')
      defaultRate = fixedDecimal(exact, 4)
    }
  }

  let defaultCost: string | null | undefined
  if (body.defaultCost !== undefined) {
    const raw = strOrNull(body.defaultCost)
    if (raw === null) defaultCost = null
    else {
      const exact = canonicalDecimal(raw, 4)
      if (exact === null || compareDecimal(exact, '0') < 0) return bad('Default cost must be a non-negative number')
      defaultCost = fixedDecimal(exact, 4)
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
      ))
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
      ))
      if (!r.rows[0]) return bad('Expense account not found')
    }
    expenseAccountId = v
  }

  let costRecoveryAccountId: string | null | undefined
  if (body.costRecoveryAccountId !== undefined) {
    const v = uuidOrNull(body.costRecoveryAccountId)
    if (v === 'invalid') return bad('Invalid recovery account')
    if (v !== null) {
      const r = (await db.execute(sql`select 1 from accounts where id = ${v} and org_id = ${user.orgId}`))
      if (!r.rows[0]) return bad('Recovery account not found')
    }
    costRecoveryAccountId = v
  }

  let taxCodeId: string | null | undefined
  if (body.taxCodeId !== undefined) {
    const v = uuidOrNull(body.taxCodeId)
    if (v === 'invalid') return bad('Invalid tax code')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from tax_codes where id = ${v} and org_id = ${user.orgId}`,
      ))
      if (!r.rows[0]) return bad('Tax code not found')
    }
    taxCodeId = v
  }

  // -- revenue recognition -------------------------------------------------
  let recognitionRuleId: string | null | undefined
  if (body.recognitionRuleId !== undefined) {
    const v = uuidOrNull(body.recognitionRuleId)
    if (v === 'invalid') return bad('Invalid recognition rule')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from recognition_rules where id = ${v} and org_id = ${user.orgId}`,
      ))
      if (!r.rows[0]) return bad('Recognition rule not found')
    }
    recognitionRuleId = v
  }

  let deferredAccountId: string | null | undefined
  if (body.deferredAccountId !== undefined) {
    const v = uuidOrNull(body.deferredAccountId)
    if (v === 'invalid') return bad('Invalid deferred revenue account')
    if (v !== null) {
      const r = (await db.execute(
        sql`select 1 from accounts where id = ${v} and org_id = ${user.orgId}`,
      ))
      if (!r.rows[0]) return bad('Deferred revenue account not found')
    }
    deferredAccountId = v
  }

  if (body.createPlansOn !== undefined && !CREATE_PLANS_ON.includes(body.createPlansOn as (typeof CREATE_PLANS_ON)[number])) {
    return bad('Invalid "create plans on" value')
  }
  if (
    body.revenueAllocation !== undefined &&
    !REVENUE_ALLOCATION.includes(body.revenueAllocation as (typeof REVENUE_ALLOCATION)[number])
  ) {
    return bad('Invalid revenue allocation')
  }

  let standaloneSellingPrice: string | null | undefined
  if (body.standaloneSellingPrice !== undefined) {
    const raw = strOrNull(body.standaloneSellingPrice)
    if (raw === null) standaloneSellingPrice = null
    else {
      const exact = canonicalDecimal(raw, 4)
      if (exact === null) return bad('Standalone selling price must be a number with no more than four decimal places')
      standaloneSellingPrice = fixedDecimal(exact, 4)
    }
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
        description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
        code = ${body.code !== undefined ? strOrNull(body.code) : sql`code`},
        category = ${body.category !== undefined ? strOrNull(body.category) : sql`category`},
        unit = ${body.unit !== undefined ? strOrNull(body.unit) : sql`unit`},
        default_rate = ${defaultRate !== undefined ? defaultRate : sql`default_rate`},
        default_cost = ${defaultCost !== undefined ? defaultCost : sql`default_cost`},
        income_account_id = ${incomeAccountId !== undefined ? incomeAccountId : sql`income_account_id`},
        expense_account_id = ${expenseAccountId !== undefined ? expenseAccountId : sql`expense_account_id`},
        cost_recovery_account_id = ${costRecoveryAccountId !== undefined ? costRecoveryAccountId : sql`cost_recovery_account_id`},
        tax_code_id = ${taxCodeId !== undefined ? taxCodeId : sql`tax_code_id`},
        show_on_timesheet = ${body.showOnTimesheet !== undefined ? body.showOnTimesheet : sql`show_on_timesheet`},
        recognition_rule_id = ${recognitionRuleId !== undefined ? recognitionRuleId : sql`recognition_rule_id`},
        deferred_account_id = ${deferredAccountId !== undefined ? deferredAccountId : sql`deferred_account_id`},
        create_plans_on = ${body.createPlansOn !== undefined ? body.createPlansOn : sql`create_plans_on`},
        revenue_allocation = ${body.revenueAllocation !== undefined ? body.revenueAllocation : sql`revenue_allocation`},
        standalone_selling_price = ${standaloneSellingPrice !== undefined ? standaloneSellingPrice : sql`standalone_selling_price`},
        is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
        custom = coalesce(${cleanedCustom ? JSON.stringify(cleanedCustom) : null}::jsonb, custom),
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
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
