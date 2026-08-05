import { NextResponse } from 'next/server'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { createPrebill, listPrebills, WipBillingError } from '../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined
  if (projectId && !isUuid(projectId)) return NextResponse.json({ error: 'invalid projectId' }, { status: 400 })
  return NextResponse.json({ prebills: await listPrebills(gate.user.orgId, projectId) })
}

export async function POST(req: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || !isUuid(String(body.projectId ?? ''))) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  try {
    const result = await createPrebill(gate.user.orgId, gate.user.id, {
      projectId: String(body.projectId),
      periodStart: body.periodStart == null ? null : String(body.periodStart),
      periodEnd: String(body.periodEnd ?? ''),
      notes: body.notes == null ? null : String(body.notes),
    })
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    const status = error instanceof WipBillingError ? error.status : 500
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
