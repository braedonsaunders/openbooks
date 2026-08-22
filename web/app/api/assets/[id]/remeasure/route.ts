import { NextResponse } from 'next/server'
import { remeasureAsset } from '@openbooks/engine/src/asset-lifecycle.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Revalue or impair an asset to a new carrying value: posts the adjustment and
 *  rebuilds the remaining depreciation schedule on the new basis. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid asset' }, { status: 422 })

  const body = (await req.json().catch(() => ({}))) as { newCarryingValue?: string; date?: string }
  const carryingRaw = canonicalDecimal(body.newCarryingValue, 4)
  if (carryingRaw === null || compareDecimal(carryingRaw, '0') < 0) {
    return NextResponse.json({ error: 'enter the new carrying value' }, { status: 422 })
  }
  const newCarryingValue = normalizeMoney(carryingRaw)
  const date = body.date && DATE_RE.test(body.date) ? body.date : await businessToday(gate.user.orgId)

  try {
    const result = await remeasureAsset(gate.user.orgId, id, { newCarryingValue, date, actorId: gate.user.id })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'remeasurement failed' }, { status: 422 })
  }
}
