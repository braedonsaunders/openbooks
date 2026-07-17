import { NextResponse } from 'next/server'
import { remeasureAsset } from '@openbooks/engine/src/asset-lifecycle.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_RE = /^\d+(\.\d+)?$/

/** Revalue or impair an asset to a new carrying value: posts the adjustment and
 *  rebuilds the remaining depreciation schedule on the new basis. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid asset' }, { status: 422 })

  const body = (await req.json().catch(() => ({}))) as { newCarryingValue?: string; date?: string }
  const newCarryingValue = String(body.newCarryingValue ?? '')
  if (!AMOUNT_RE.test(newCarryingValue)) {
    return NextResponse.json({ error: 'enter the new carrying value' }, { status: 422 })
  }
  const date = body.date && DATE_RE.test(body.date) ? body.date : new Date().toISOString().slice(0, 10)

  try {
    const result = await remeasureAsset(gate.user.orgId, id, { newCarryingValue, date, actorId: gate.user.id })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'remeasurement failed' }, { status: 422 })
  }
}
