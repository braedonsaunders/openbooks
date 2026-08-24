import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { createBillingRequest, listBillingRequests } from '../../../lib/billing-requests'
import { canonicalDecimal } from '../../../lib/exact-decimal'
import { guardProjectsFeature } from '../../../lib/projects-gate'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId || !isUuid(projectId)) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  const requests = await listBillingRequests(gate.user.orgId, projectId)
  return NextResponse.json({ requests })
}

export async function POST(req: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data))
  if (!body?.projectId || !isUuid(String(body.projectId))) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  let drawAmount: string | null = null
  if (body.drawAmount != null && body.drawAmount !== '') {
    const exact = canonicalDecimal(body.drawAmount, 4)
    if (exact === null) {
      return NextResponse.json({ error: 'Draw amount must be an exact decimal' }, { status: 422 })
    }
    try {
      drawAmount = normalizeMoney(exact)
    } catch {
      return NextResponse.json({ error: 'Draw amount must be an exact decimal' }, { status: 422 })
    }
  }
  try {
    const created = await createBillingRequest(gate.user.orgId, gate.user.id, {
      ...body,
      projectId: body.projectId,
      drawAmount,
    })
    return NextResponse.json(created)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 })
  }
}
