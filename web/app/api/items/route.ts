import { exactMoney, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import { guardPermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { canonicalDecimal, compareDecimal, fixedDecimal } from '../../../lib/exact-decimal'
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
import { isUuid } from '../../../lib/list-params'
import { loadItem } from './_lib'

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
const PAYROLL_COSTING_ACCOUNT_TYPES = new Set([
  'expense',
  'expense_other',
  'expense_deferred',
  'cogs',
  'asset_current_other',
])
const CREATE_PLANS_ON = ['billing', 'fulfillment', 'arrangement'] as const
const REVENUE_ALLOCATION = ['normal', 'exclude', 'software'] as const

const nullableText = z.string().nullable().optional()
const nullableMoney = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? null : value,
  exactMoney().nullable(),
).optional()

const itemCreateSchema = z.looseObject({
  kind: z.string(),
  code: nullableText,
  name: z.string(),
  description: nullableText,
  category: nullableText,
  unit: nullableText,
  defaultRate: nullableMoney,
  defaultCost: nullableMoney,
  incomeAccountId: nullableText,
  expenseAccountId: nullableText,
  payrollExpenseAccountId: nullableText,
  costRecoveryAccountId: nullableText,
  taxCodeId: nullableText,
  showOnTimesheet: z.boolean().optional(),
  isActive: z.boolean().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  recognitionRuleId: nullableText,
  deferredAccountId: nullableText,
  createPlansOn: z.string().optional(),
  revenueAllocation: z.string().optional(),
  standaloneSellingPrice: nullableMoney,
})

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function uuidOrNull(value: unknown): string | null | 'invalid' {
  const normalized = textOrNull(value)
  if (normalized === null) return null
  return isUuid(normalized) ? normalized : 'invalid'
}

function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

function money(
  value: unknown,
  label: string,
  options: { nonNegative?: boolean } = {},
): { ok: true; value: string | null } | { ok: false; response: NextResponse } {
  const raw = textOrNull(value)
  if (raw === null) return { ok: true, value: null }
  const exact = canonicalDecimal(raw, 4)
  if (exact === null) {
    return { ok: false, response: bad(moneyRefusal(label, raw)) }
  }
  if (options.nonNegative && compareDecimal(exact, '0') < 0) {
    return { ok: false, response: bad(`${label} must be a non-negative number with no more than four decimal places`) }
  }
  if (wholeDigits(exact) > 15) {
    return { ok: false, response: bad(`${label} is out of range — at most 15 whole digits fit the ledger`) }
  }
  return { ok: true, value: fixedDecimal(exact, 4) }
}

/**
 * Create one tenant-owned item. The client-generated UUID is both the row id
 * and idempotency key, so a retried Save cannot create a second item or audit.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('Invalid idempotency key', 400)

  const parsed = await parseJsonBody(request, itemCreateSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const name = body.name.trim()
  if (!name) return bad('Name is required')
  if (!ITEM_KINDS.includes(body.kind as (typeof ITEM_KINDS)[number])) return bad('Invalid item kind')
  if (body.createPlansOn !== undefined && !CREATE_PLANS_ON.includes(body.createPlansOn as (typeof CREATE_PLANS_ON)[number])) {
    return bad('Invalid "create plans on" value')
  }
  if (body.revenueAllocation !== undefined && !REVENUE_ALLOCATION.includes(body.revenueAllocation as (typeof REVENUE_ALLOCATION)[number])) {
    return bad('Invalid revenue allocation')
  }

  const defaultRateResult = money(body.defaultRate, 'Default rate')
  if (!defaultRateResult.ok) return defaultRateResult.response
  const defaultCostResult = money(body.defaultCost, 'Default cost', { nonNegative: true })
  if (!defaultCostResult.ok) return defaultCostResult.response
  const standalonePriceResult = money(body.standaloneSellingPrice, 'Standalone selling price')
  if (!standalonePriceResult.ok) return standalonePriceResult.response

  const references = {
    incomeAccountId: uuidOrNull(body.incomeAccountId),
    expenseAccountId: uuidOrNull(body.expenseAccountId),
    payrollExpenseAccountId: uuidOrNull(body.payrollExpenseAccountId),
    costRecoveryAccountId: uuidOrNull(body.costRecoveryAccountId),
    taxCodeId: uuidOrNull(body.taxCodeId),
    recognitionRuleId: uuidOrNull(body.recognitionRuleId),
    deferredAccountId: uuidOrNull(body.deferredAccountId),
  }
  const invalidReference = Object.entries(references).find(([, value]) => value === 'invalid')
  if (invalidReference) return bad(`Invalid ${invalidReference[0]}`)

  const code = textOrNull(body.code)
  const description = textOrNull(body.description)
  const category = textOrNull(body.category)
  const unit = textOrNull(body.unit)
  const isActive = body.isActive !== false
  const createPlansOn = body.createPlansOn ?? 'billing'
  const revenueAllocation = body.revenueAllocation ?? 'normal'

  let snapshot: Record<string, unknown> | null = null
  let created = false
  try {
    created = await withOrgTransaction(gate.user.orgId, async () => {
      if (INVENTORY_ITEM_KINDS.has(body.kind) && !(await isFeatureEnabled(gate.user.orgId, 'inventory'))) {
        throw new CreateNotFound()
      }
      if (body.kind === 'equipment_charge' && !(await isFeatureEnabled(gate.user.orgId, 'equipment'))) {
        throw new CreateNotFound()
      }
      if (body.showOnTimesheet !== undefined && !(await isFeatureEnabled(gate.user.orgId, 'timeTracking'))) {
        throw new CreateNotFound()
      }
      const touchesRevenueRecognition = body.recognitionRuleId !== undefined
        || body.deferredAccountId !== undefined
        || body.createPlansOn !== undefined
        || body.revenueAllocation !== undefined
        || body.standaloneSellingPrice !== undefined
      if (touchesRevenueRecognition && !(await isFeatureEnabled(gate.user.orgId, 'revenueRecognition'))) {
        throw new CreateNotFound()
      }

      const customDefs = await loadFieldDefs('items')
      const validatedCustom = validateCustomValues(customDefs, body.custom ?? {})
      if (!validatedCustom.ok) throw new CreateInvalid(Object.values(validatedCustom.errors)[0] ?? 'Invalid custom fields')
      const unowned = await findUnownedCustomReferences(gate.user.orgId, customDefs, validatedCustom.cleaned)
      if (unowned.length > 0) throw new CreateInvalid(`${unowned[0]!.label} not found in this organization`)

      const accountReference = async (id: string | null, label: string, payroll = false): Promise<void> => {
        if (!id) return
        const result = await db.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
          select type, is_active, is_summary
            from accounts
           where id = ${id} and org_id = ${gate.user.orgId}
        `)
        const row = result.rows[0]
        if (!row) throw new CreateInvalid(`${label} not found`)
        if (payroll && !row.is_active) throw new CreateInvalid('Payroll costing account is inactive')
        if (payroll && row.is_summary) throw new CreateInvalid('Summary accounts cannot receive worked-hours cost')
        if (payroll && !PAYROLL_COSTING_ACCOUNT_TYPES.has(row.type)) {
          throw new CreateInvalid(`Payroll costing account type ${row.type} cannot receive worked-hours cost`)
        }
      }
      await accountReference(references.incomeAccountId as string | null, 'Income account')
      await accountReference(references.expenseAccountId as string | null, 'Expense account')
      await accountReference(references.payrollExpenseAccountId as string | null, 'Payroll costing account', true)
      await accountReference(references.costRecoveryAccountId as string | null, 'Recovery account')
      await accountReference(references.deferredAccountId as string | null, 'Deferred revenue account')

      const assertOwned = async (table: 'tax_codes' | 'recognition_rules', id: string | null, label: string): Promise<void> => {
        if (!id) return
        const result = await db.execute(sql`select 1 from ${sql.raw(table)} where id = ${id} and org_id = ${gate.user.orgId}`)
        if (!result.rows[0]) throw new CreateInvalid(`${label} not found`)
      }
      await assertOwned('tax_codes', references.taxCodeId as string | null, 'Tax code')
      await assertOwned('recognition_rules', references.recognitionRuleId as string | null, 'Recognition rule')

      snapshot = {
        id: requestId,
        org_id: gate.user.orgId,
        kind: body.kind,
        code,
        name,
        description,
        category,
        unit,
        default_rate: defaultRateResult.value,
        default_cost: defaultCostResult.value,
        income_account_id: references.incomeAccountId,
        expense_account_id: references.expenseAccountId,
        payroll_expense_account_id: references.payrollExpenseAccountId,
        cost_recovery_account_id: references.costRecoveryAccountId,
        tax_code_id: references.taxCodeId,
        show_on_timesheet: body.showOnTimesheet === true,
        recognition_rule_id: references.recognitionRuleId,
        deferred_account_id: references.deferredAccountId,
        create_plans_on: createPlansOn,
        revenue_allocation: revenueAllocation,
        standalone_selling_price: standalonePriceResult.value,
        is_active: isActive,
        custom: validatedCustom.cleaned,
      }

      // A duplicate id is an expected HTTP retry, never a dropped business
      // write: the immutable insert audit below proves whether it is the same
      // command before we return success.
      const inserted = await db.execute<{ id: string }>(sql`
        insert into items
          (id, org_id, kind, code, name, description, category, unit,
           default_rate, default_cost, income_account_id, expense_account_id,
           payroll_expense_account_id, cost_recovery_account_id, tax_code_id,
           show_on_timesheet, recognition_rule_id, deferred_account_id,
           create_plans_on, revenue_allocation, standalone_selling_price,
           is_active, custom, created_by, updated_by)
        values
          (${requestId}, ${gate.user.orgId}, ${body.kind}, ${code}, ${name}, ${description}, ${category}, ${unit},
           ${defaultRateResult.value}, ${defaultCostResult.value}, ${references.incomeAccountId}, ${references.expenseAccountId},
           ${references.payrollExpenseAccountId}, ${references.costRecoveryAccountId}, ${references.taxCodeId},
           ${body.showOnTimesheet === true}, ${references.recognitionRuleId}, ${references.deferredAccountId},
           ${createPlansOn}, ${revenueAllocation}, ${standalonePriceResult.value},
           ${isActive}, ${JSON.stringify(validatedCustom.cleaned)}::jsonb, ${gate.user.id}, ${gate.user.id})
        on conflict (id) do nothing
        returning id
      `)
      if (!inserted.rows[0]) {
        const original = (await db.execute<{ after: unknown }>(sql`
          select changes->'after' as after
            from audit_log
           where org_id = ${gate.user.orgId}
             and table_name = 'items'
             and row_id = ${requestId}
             and action = 'insert'
             and request_id = ${requestId}
           order by at asc
           limit 1
        `)).rows[0]?.after
        if (!original || canonicalJson(original) !== canonicalJson(snapshot)) throw new CreateConflict()
        return false
      }

      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${gate.user.orgId}, 'items', ${requestId}, 'insert',
           ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
           ${gate.user.id}, ${requestId})
      `)
      return true
    })
  } catch (error) {
    if (error instanceof CreateNotFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (error instanceof CreateInvalid) return bad(error.message)
    if (error instanceof CreateConflict) return bad('Invalid idempotency key', 409)
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('items_org_code')) return bad('Code already in use')
    throw error
  }

  const payload = await loadItem(requestId, gate.user.orgId)
  if (!payload) return bad('The item was saved but could not be read back', 500)
  return NextResponse.json(payload, { status: created ? 201 : 200 })
}

class CreateInvalid extends Error {}
class CreateNotFound extends Error {}
class CreateConflict extends Error {}
