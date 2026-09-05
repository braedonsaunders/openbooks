import { jsonObject, parseJsonBody } from "@/lib/api/json";
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data))
  if (body?.action === 'cancel') {
    try {
      await cancelBillingRequest(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if ((e as Error).message === 'Billing request not found') return NextResponse.json({ error: 'not found' }, { status: 404 })
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }
  return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
}
