import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { divRate, mul } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { resolveItemRate } from '../../../../lib/item-rates'

export const runtime = 'nodejs'

/** Live item-price preview using the same assignment and tier engine as charges. */
export async function GET(req: Request) {
  const gate = await guardPermission('time.read')
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'fieldTickets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const q = new URL(req.url).searchParams
  const projectId = q.get('projectId')
  const itemId = q.get('itemId')
  const equipmentUnitId = q.get('equipmentUnitId') || null
  const rateUnitCode = q.get('rateUnitCode')?.trim().toLowerCase() || null
  const quantity = q.get('quantity') ?? ''
  const onDate = q.get('onDate') ?? ''
  if (!projectId || !itemId || !isUuid(projectId) || !isUuid(itemId) || (equipmentUnitId && !isUuid(equipmentUnitId))) {
    return NextResponse.json({ error: 'invalid selection' }, { status: 422 })
  }
  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
    return NextResponse.json({ error: 'invalid quantity or date' }, { status: 422 })
  }
  if (rateUnitCode && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rateUnitCode)) {
    return NextResponse.json({ error: 'invalid rate unit' }, { status: 422 })
  }

  const item = (await db.execute(sql`
    select default_rate, default_cost, unit from items
     where id = ${itemId} and org_id = ${gate.user.orgId} and is_active
  `)) as unknown as { rows: { default_rate: string | null; default_cost: string | null; unit: string | null }[] }
  if (!item.rows[0]) return NextResponse.json({ error: 'item not found' }, { status: 404 })

  let resolved: Awaited<ReturnType<typeof resolveItemRate>>
  try {
    resolved = await resolveItemRate({
      orgId: gate.user.orgId,
      projectId,
      itemId,
      equipmentUnitId,
      onDate,
      baseQuantity: quantity,
      rateUnitCode,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not resolve item rate' }, { status: 422 })
  }
  const fallbackRate = item.rows[0].default_rate ?? item.rows[0].default_cost ?? '0'
  const amount = resolved?.bill.amount ?? mul(quantity, fallbackRate)
  return NextResponse.json({
    rate: divRate(amount, quantity),
    amount,
    baseUnit: resolved?.baseUnit ?? item.rows[0].unit ?? 'unit',
    baseQuantity: resolved?.baseQuantity ?? quantity,
    transactionUnitCode: resolved?.transactionUnitCode ?? item.rows[0].unit ?? 'unit',
    transactionUnitName: resolved?.transactionUnitName ?? item.rows[0].unit ?? 'Unit',
    rateUnits: resolved?.rateUnits ?? [],
    source: resolved ? 'rate_book' : 'item_default',
    components: resolved?.bill.components ?? [],
  })
}
