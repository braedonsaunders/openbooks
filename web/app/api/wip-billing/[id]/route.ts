import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadPrebill, transitionPrebill, WipBillingError } from '../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const prebill = await loadPrebill(gate.user.orgId, id)
  return prebill ? NextResponse.json({ prebill }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { action?: string; reason?: string } | null
  const permission = body?.action === 'approve' ? 'ar.approve' : 'projects.manage'
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!body || !['submit', 'return', 'approve', 'void'].includes(String(body.action))) {
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
  }
  try {
    const result = await transitionPrebill(
      gate.user.orgId,
      gate.user.id,
      id,
      body.action as 'submit' | 'return' | 'approve' | 'void',
      body.reason,
    )
    return NextResponse.json(result)
  } catch (error) {
    const status = error instanceof WipBillingError ? error.status : 500
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
