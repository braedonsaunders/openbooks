import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { cancelBillingRequest } from '../../../../lib/billing-requests'
import { guardProjectsFeature } from '../../../../lib/projects-gate'

export const runtime = 'nodejs'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as any
  if (body?.action === 'cancel') {
    try {
      await cancelBillingRequest(gate.user.orgId, gate.user.id, id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }
  return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
}
