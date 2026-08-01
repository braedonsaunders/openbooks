import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { releaseWipHold, WipBillingError } from '../../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => null)) as { reason?: string } | null
  try {
    return NextResponse.json(await releaseWipHold(gate.user.orgId, gate.user.id, id, body?.reason ?? ''))
  } catch (error) {
    const status = error instanceof WipBillingError ? error.status : 500
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
