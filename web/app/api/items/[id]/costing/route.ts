import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Per-item inventory costing profile (item_inventory_profiles) — one row per
 * item. Re-homed from the Setup workspace onto the item record, so it is gated
 * by the item permissions rather than admin.setup.manage, and by the Inventory
 * Features switch (same key as the setup entity). GET returns the current
 * profile (or null); PUT upserts it.
 */

const COSTING_METHODS = ['fifo', 'moving_average', 'standard']
const TRACKING = ['none', 'lot', 'serial']

async function loadItem(id: string, orgId: string) {
  const item = (await db.execute(sql`select 1 from items where id = ${id} and org_id = ${orgId}`)) as any
  return Boolean(item.rows[0])
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.read', 'inventory')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id) || !(await loadItem(id, gate.user.orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const profile = (await db.execute(sql`
    select costing_method, tracking, asset_account_id, cogs_account_id,
           adjustment_account_id, variance_account_id, received_not_billed_account_id,
           standard_cost, base_unit, reorder_point, preferred_stock_level,
           allow_negative_inventory, negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles
     where org_id = ${gate.user.orgId} and item_id = ${id}`)) as any
  return NextResponse.json({ profile: profile.rows[0] ?? null })
}

function accountRef(value: unknown): string | null {
  return value && isUuid(String(value)) ? String(value) : null
}

function numeric(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const text = String(value).trim()
  return /^\+?(?:\d+(?:\.\d{0,4})?|\.\d{1,4})$/.test(text) ? text.replace(/^\+/, '') : null
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'inventory')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id) || !(await loadItem(id, orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const costingMethod = COSTING_METHODS.includes(String(body.costingMethod)) ? String(body.costingMethod) : 'moving_average'
  const tracking = TRACKING.includes(String(body.tracking)) ? String(body.tracking) : 'none'
  const assetAccountId = accountRef(body.assetAccountId)
  const cogsAccountId = accountRef(body.cogsAccountId)
  if (!assetAccountId || !cogsAccountId) {
    return NextResponse.json({ error: 'The asset and COGS accounts are required' }, { status: 400 })
  }
  const baseUnit = String(body.baseUnit ?? '').trim() || 'ea'
  const adjustmentAccountId = accountRef(body.adjustmentAccountId)
  const varianceAccountId = accountRef(body.varianceAccountId)
  const receivedNotBilledAccountId = accountRef(body.receivedNotBilledAccountId)
  const standardCost = numeric(body.standardCost)
  const reorderPoint = numeric(body.reorderPoint)
  const preferredStockLevel = numeric(body.preferredStockLevel)
  const allowNegativeInventory = body.allowNegativeInventory === true
  const negativeCostBasis = ['last_receipt', 'standard', 'configured'].includes(String(body.negativeCostBasis))
    ? String(body.negativeCostBasis)
    : 'last_receipt'
  const provisionalUnitCost = numeric(body.provisionalUnitCost)
  if (allowNegativeInventory && negativeCostBasis === 'configured' && provisionalUnitCost == null) {
    return NextResponse.json({ error: 'A configured provisional cost is required for negative inventory' }, { status: 400 })
  }
  if (allowNegativeInventory && negativeCostBasis === 'standard' && standardCost == null) {
    return NextResponse.json({ error: 'A standard cost is required for standard provisional costing' }, { status: 400 })
  }

  try {
    await db.execute(sql`
      insert into item_inventory_profiles
        (org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id,
         adjustment_account_id, variance_account_id, received_not_billed_account_id,
         standard_cost, base_unit, reorder_point, preferred_stock_level,
         allow_negative_inventory, negative_cost_basis, provisional_unit_cost, created_by, updated_by)
      values
        (${orgId}, ${id}, ${costingMethod}, ${tracking}, ${assetAccountId}, ${cogsAccountId},
         ${adjustmentAccountId}, ${varianceAccountId}, ${receivedNotBilledAccountId},
         ${standardCost}, ${baseUnit}, ${reorderPoint}, ${preferredStockLevel},
         ${allowNegativeInventory}, ${negativeCostBasis}, ${provisionalUnitCost}, ${actorId}, ${actorId})
      on conflict (item_id) do update set
        costing_method = excluded.costing_method,
        tracking = excluded.tracking,
        asset_account_id = excluded.asset_account_id,
        cogs_account_id = excluded.cogs_account_id,
        adjustment_account_id = excluded.adjustment_account_id,
        variance_account_id = excluded.variance_account_id,
        received_not_billed_account_id = excluded.received_not_billed_account_id,
        standard_cost = excluded.standard_cost,
        base_unit = excluded.base_unit,
        reorder_point = excluded.reorder_point,
        preferred_stock_level = excluded.preferred_stock_level,
        allow_negative_inventory = excluded.allow_negative_inventory,
        negative_cost_basis = excluded.negative_cost_basis,
        provisional_unit_cost = excluded.provisional_unit_cost,
        updated_at = now(), updated_by = ${actorId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'item_inventory_profiles', ${id}, 'update',
              ${JSON.stringify({ costingMethod, tracking, assetAccountId, cogsAccountId, standardCost })}, ${actorId})`)
    return NextResponse.json({ ok: true })
  } catch (e) {
    // FK violation → an account id doesn't belong to this org / isn't postable.
    if ((e as { code?: string })?.code === '23503') {
      return NextResponse.json({ error: 'Choose posting accounts from this organization' }, { status: 400 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
