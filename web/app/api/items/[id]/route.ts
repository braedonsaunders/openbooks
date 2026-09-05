import { exactMoney, jsonObject, parseJsonBody } from "@/lib/api/json";
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
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

const nullableText = z.string().nullable().optional()
const nullableMoney = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? null : value,
  exactMoney().nullable(),
).optional()

// Validate the complete patch shape before normalization. Non-text values must
// never become silent clears, and PostgreSQL must not coerce lifecycle flags.
const itemPatchSchema = z.looseObject({
  kind: z.string().optional(),
  code: nullableText,
  name: z.string().optional(),
  description: nullableText,
  category: nullableText,
  unit: nullableText,
  defaultRate: nullableMoney,
  defaultCost: nullableMoney,
  incomeAccountId: nullableText,
  expenseAccountId: nullableText,
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
  reason: nullableText,
  changeReason: nullableText,
})
type PatchBody = z.output<typeof itemPatchSchema>

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

/**
 * The fields whose values determine how an item is posted, priced, taxed, or
 * recognized. Keep this list explicit: an audit row must be sufficient to
 * reconstruct the accounting configuration without consulting the mutable
 * item row later.
 */
const ITEM_ACCOUNTING_CONFIGURATION_FIELDS = [
  'kind',
  'code',
  'name',
  'description',
  'category',
  'unit',
  'default_rate',
  'default_cost',
  'income_account_id',
  'expense_account_id',
  'cost_recovery_account_id',
  'tax_code_id',
  'show_on_timesheet',
  'recognition_rule_id',
  'deferred_account_id',
  'create_plans_on',
  'revenue_allocation',
  'standalone_selling_price',
  'is_active',
  'custom',
  'updated_at',
  'updated_by',
] as const

function accountingConfiguration(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ITEM_ACCOUNTING_CONFIGURATION_FIELDS.map((field) => [field, row[field] ?? null]),
  )
}

/** A validation failure discovered after the item row is locked. */
class PatchInvalid extends Error {}

/** The item disappeared or a feature gate closed before the locked read. */
class PatchNotFound extends Error {}

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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const fields = itemPatchSchema.safeParse(parsedBody.data)
  if (!fields.success) return bad(fields.error.issues[0]?.message ?? 'Invalid item fields')
  const body = fields.data

  // -- kind ----------------------------------------------------------------
  if (body.kind !== undefined && !ITEM_KINDS.includes(body.kind as (typeof ITEM_KINDS)[number])) {
    return bad('Invalid item kind')
  }

  // -- name / activation ---------------------------------------------------
  const name = body.name !== undefined ? body.name.trim() : undefined

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
  // IDs are normalized before the transaction; authoritative existence checks
  // happen below after the item row is locked, so a concurrent account change
  // cannot make the audit's before-image disagree with the committed write.
  let incomeAccountId: string | null | undefined
  if (body.incomeAccountId !== undefined) {
    const v = uuidOrNull(body.incomeAccountId)
    if (v === 'invalid') return bad('Invalid income account')
    incomeAccountId = v
  }

  let expenseAccountId: string | null | undefined
  if (body.expenseAccountId !== undefined) {
    const v = uuidOrNull(body.expenseAccountId)
    if (v === 'invalid') return bad('Invalid expense account')
    expenseAccountId = v
  }

  let costRecoveryAccountId: string | null | undefined
  if (body.costRecoveryAccountId !== undefined) {
    const v = uuidOrNull(body.costRecoveryAccountId)
    if (v === 'invalid') return bad('Invalid recovery account')
    costRecoveryAccountId = v
  }

  let taxCodeId: string | null | undefined
  if (body.taxCodeId !== undefined) {
    const v = uuidOrNull(body.taxCodeId)
    if (v === 'invalid') return bad('Invalid tax code')
    taxCodeId = v
  }

  // -- revenue recognition -------------------------------------------------
  let recognitionRuleId: string | null | undefined
  if (body.recognitionRuleId !== undefined) {
    const v = uuidOrNull(body.recognitionRuleId)
    if (v === 'invalid') return bad('Invalid recognition rule')
    recognitionRuleId = v
  }

  let deferredAccountId: string | null | undefined
  if (body.deferredAccountId !== undefined) {
    const v = uuidOrNull(body.deferredAccountId)
    if (v === 'invalid') return bad('Invalid deferred revenue account')
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

  const reason = strOrNull(body.reason ?? body.changeReason)

  try {
    const updated = await withOrgTransaction(user.orgId, async () => {
      // This is the authoritative before-image. The tenant-pinned transaction
      // and row lock serialize every item configuration edit, including the
      // audit insert below, so concurrent writers cannot falsify evidence.
      const locked = await db.execute<Record<string, unknown>>(sql`
        select * from items where id = ${id} and org_id = ${user.orgId} for update
      `)
      const before = locked.rows[0]
      if (!before) throw new PatchNotFound()

      if (bodyTouchesRevenueRecognition(body) && !(await isFeatureEnabled(user.orgId, 'revenueRecognition'))) {
        throw new PatchNotFound()
      }
      if (body.showOnTimesheet !== undefined && !(await isFeatureEnabled(user.orgId, 'timeTracking'))) {
        throw new PatchNotFound()
      }
      // Inventory kinds (inventory / assembly / kit) are Inventory configuration.
      // Turning that switch off must refuse a new write; the stored kind stays.
      if (body.kind !== undefined && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
        const nextKind = String(body.kind)
        const storedKind = String(before.kind ?? '')
        if (INVENTORY_ITEM_KINDS.has(nextKind) || (INVENTORY_ITEM_KINDS.has(storedKind) && nextKind !== storedKind)) {
          throw new PatchNotFound()
        }
      }
      // Equipment-charge kind is Equipment configuration.
      // Turning that switch off must refuse a new write; the stored kind stays.
      if (body.kind !== undefined && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
        const nextKind = String(body.kind)
        const storedKind = String(before.kind ?? '')
        if (nextKind === 'equipment_charge' && nextKind !== storedKind) {
          throw new PatchNotFound()
        }
      }

      const willBeActive = body.isActive ?? Boolean(before.is_active)
      const effectiveName = name ?? String(before.name ?? '').trim()
      if (willBeActive && (!effectiveName || effectiveName === 'New item')) {
        throw new PatchInvalid(
          body.isActive === true ? 'Give the item a real name before activating it' : 'An active item needs a name',
        )
      }

      const assertReference = async (
        table: 'accounts' | 'tax_codes' | 'recognition_rules',
        value: string | null | undefined,
        error: string,
      ): Promise<void> => {
        if (value === undefined || value === null) return
        const found = await db.execute(sql`
          select 1 from ${sql.raw(table)} where id = ${value} and org_id = ${user.orgId}
        `)
        if (!found.rows[0]) throw new PatchInvalid(error)
      }
      await assertReference('accounts', incomeAccountId, 'Income account not found')
      await assertReference('accounts', expenseAccountId, 'Expense account not found')
      await assertReference('accounts', costRecoveryAccountId, 'Recovery account not found')
      await assertReference('tax_codes', taxCodeId, 'Tax code not found')
      await assertReference('recognition_rules', recognitionRuleId, 'Recognition rule not found')
      await assertReference('accounts', deferredAccountId, 'Deferred revenue account not found')

      const written = await db.execute<Record<string, unknown>>(sql`
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
        returning *
      `)
      const after = written.rows[0]
      if (!after) throw new Error('item_changed')

      const changes: Record<string, unknown> = {
        before: accountingConfiguration(before),
        after: accountingConfiguration(after),
      }
      if (reason !== null) changes.reason = reason
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
        values
          (${user.orgId}, 'items', ${id}, 'update', ${JSON.stringify(changes)}::jsonb,
           ${user.id}, ${req.headers.get('X-Request-Id')}, now())
      `)
      return after
    })
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })
  } catch (e: unknown) {
    if (e instanceof PatchNotFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (e instanceof PatchInvalid) return bad(e.message)
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (msg.includes('items_org_code')) return bad('Code already in use')
    throw e
  }

  const payload = await loadItem(id, user.orgId)
  return NextResponse.json(payload)
}
