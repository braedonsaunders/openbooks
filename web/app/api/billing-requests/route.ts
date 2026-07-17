import { NextResponse } from 'next/server'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { createBillingRequest, listBillingRequests } from '../../../lib/billing-requests'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId || !isUuid(projectId)) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  const requests = await listBillingRequests(gate.user.orgId, projectId)
  return NextResponse.json({ requests })
}

export async function POST(req: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json()) as any
  if (!body?.projectId || !isUuid(String(body.projectId))) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  try {
    const created = await createBillingRequest(gate.user.orgId, gate.user.id, body)
    return NextResponse.json(created)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 })
  }
}
