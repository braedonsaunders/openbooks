import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { holdPrebillLine, updatePrebillLine, WipBillingError } from '../../../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const { id, lineId } = await params
  if (!isUuid(id) || !isUuid(lineId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })
  try {
    if (body.action === 'hold') {
      const result = await holdPrebillLine(
        gate.user.orgId,
        gate.user.id,
        id,
        lineId,
        String(body.reason ?? ''),
        Array.isArray(body.evidence) ? body.evidence.map(String) : [],
      )
      return NextResponse.json(result)
    }
    const result = await updatePrebillLine(gate.user.orgId, gate.user.id, id, lineId, {
      proposedBillAmount: String(body.proposedBillAmount ?? ''),
      adjustmentReason: body.adjustmentReason == null ? null : String(body.adjustmentReason),
      adjustmentEvidence: Array.isArray(body.adjustmentEvidence) ? body.adjustmentEvidence.map(String) : [],
    })
    return NextResponse.json(result)
  } catch (error) {
    const status = error instanceof WipBillingError ? error.status : 500
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
