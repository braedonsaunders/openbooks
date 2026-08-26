import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import {
  InventoryError,
  assertCostingPolicyChangeAllowed,
  CostingPolicyChangeBlockedError,
  lockItemInventoryProfile,
  parseCostingMethod,
  parseTrackingMode,
  revalueOpenLayersToStandardCost,
} from '@openbooks/engine/src/inventory.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

/**
 * Per-item inventory costing profile (item_inventory_profiles) — one row per
 * item. Re-homed from the Setup workspace onto the item record, so it is gated
 * by the item permissions rather than admin.setup.manage, and by the Inventory
 * Features switch (same key as the setup entity). GET returns the current
 * profile (or null); PUT upserts it.
 *
 * costingMethod and tracking are accounting policy: they are required verbatim
 * (never defaulted), and once an item holds cost layers or movements a change
 * needs a recostingAuthorization reason, with before/after audit evidence
 * either way.
 */

async function loadItem(id: string, orgId: string) {
  const item = ((await db.execute(sql`select 1 from items where id = ${id} and org_id = ${orgId}`)))
  return Boolean(item.rows[0])
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.read', 'inventory')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id) || !(await loadItem(id, gate.user.orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const profile = ((await db.execute(sql`
    select costing_method, tracking, asset_account_id, cogs_account_id,
           adjustment_account_id, variance_account_id, received_not_billed_account_id,
           standard_cost, base_unit, reorder_point, preferred_stock_level,
           allow_negative_inventory, negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles
     where org_id = ${gate.user.orgId} and item_id = ${id}`)))
  return NextResponse.json({ profile: profile.rows[0] ?? null })
}

function accountRef(value: unknown): string | null {
  return value && isUuid(String(value)) ? String(value) : null
}

function moneyOrNull(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  return normalizeMoney(exact)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'inventory')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id) || !(await loadItem(id, orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  const costingMethod = parseCostingMethod(body.costingMethod)
  if (!costingMethod) {
    return NextResponse.json(
      { error: 'costingMethod must be one of fifo, moving_average, or standard' },
      { status: 422 },
    )
  }
  const tracking = parseTrackingMode(body.tracking)
  if (!tracking) {
    return NextResponse.json(
      { error: 'tracking must be one of none, lot, or serial' },
      { status: 422 },
    )
  }
  let recostingAuthorization: string | null = null
  if (body.recostingAuthorization !== undefined && body.recostingAuthorization !== null) {
    if (typeof body.recostingAuthorization !== 'string') {
      return NextResponse.json({ error: 'recostingAuthorization must be a string' }, { status: 422 })
    }
    recostingAuthorization = body.recostingAuthorization
  }
  const assetAccountId = accountRef(body.assetAccountId)
  const cogsAccountId = accountRef(body.cogsAccountId)
  if (!assetAccountId || !cogsAccountId) {
    return NextResponse.json({ error: 'The asset and COGS accounts are required' }, { status: 400 })
  }
  const baseUnit = String(body.baseUnit ?? '').trim() || 'ea'
  const adjustmentAccountId = accountRef(body.adjustmentAccountId)
  const varianceAccountId = accountRef(body.varianceAccountId)
  const receivedNotBilledAccountId = accountRef(body.receivedNotBilledAccountId)
  const standardCost = moneyOrNull(body.standardCost)
  const reorderPoint = moneyOrNull(body.reorderPoint)
  const preferredStockLevel = moneyOrNull(body.preferredStockLevel)
  const allowNegativeInventory = body.allowNegativeInventory === true
  const negativeCostBasis = ['last_receipt', 'standard', 'configured'].includes(String(body.negativeCostBasis))
    ? String(body.negativeCostBasis)
    : 'last_receipt'
  const provisionalUnitCost = moneyOrNull(body.provisionalUnitCost)
  if (
    standardCost === 'invalid'
    || reorderPoint === 'invalid'
    || preferredStockLevel === 'invalid'
    || provisionalUnitCost === 'invalid'
  ) {
    return NextResponse.json({ error: 'Costs and stock levels must be numbers with no more than four decimal places' }, { status: 422 })
  }
  if (allowNegativeInventory && negativeCostBasis === 'configured' && provisionalUnitCost == null) {
    return NextResponse.json({ error: 'A configured provisional cost is required for negative inventory' }, { status: 400 })
  }
  if (allowNegativeInventory && negativeCostBasis === 'standard' && standardCost == null) {
    return NextResponse.json({ error: 'A standard cost is required for standard provisional costing' }, { status: 400 })
  }

  try {
    const result = await db.transaction(async (tx) => {
      const before = await lockItemInventoryProfile(tx, orgId, id)
      const assessment = await assertCostingPolicyChangeAllowed(
        tx,
        orgId,
        id,
        before,
        { costingMethod, tracking },
        recostingAuthorization,
      )
      const authorizedFlip = assessment.changed && assessment.historyExisted
      const revaluationEntryId =
        authorizedFlip && costingMethod === 'standard' && before?.costing_method !== 'standard'
          ? await revalueOpenLayersToStandardCost(tx, orgId, actorId, id, {
              standardCost,
              assetAccountId,
              varianceAccountId,
            })
          : null

      const afterRows = ((await tx.execute(sql`
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
          updated_at = now(), updated_by = ${actorId}
        where item_inventory_profiles.org_id = ${orgId}
        returning *`)))
      const changes: Record<string, unknown> = { before: before ?? null, after: afterRows.rows[0] ?? null }
      if (authorizedFlip) {
        changes.recostingAuthorization = recostingAuthorization!.trim()
        changes.revaluationEntryId = revaluationEntryId
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'item_inventory_profiles', ${id}, ${before ? 'update' : 'create'},
                ${JSON.stringify(changes)}, ${actorId})`)
      return { policyChanged: assessment.changed, revaluationEntryId }
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof CostingPolicyChangeBlockedError) {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'item_inventory_profiles', ${id}, 'update',
                ${JSON.stringify({
                  refused: true,
                  requested: { costingMethod, tracking },
                  reason: e.message,
                })}, ${actorId})`).catch(() => {})
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    // FK violation → an account id doesn't belong to this org / isn't postable.
    if ((e as { code?: string })?.code === '23503') {
      return NextResponse.json({ error: 'Choose posting accounts from this organization' }, { status: 400 })
    }
    if (e instanceof InventoryError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
