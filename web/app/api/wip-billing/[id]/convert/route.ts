import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { convertPrebill } from '../../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    return NextResponse.json(await convertPrebill(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds))
  } catch (error) {
    return apiErrorResponse(error)
  }
}
