import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { recognizeProjectRevenue } from '@openbooks/engine/src/project-recognition.ts'

export const runtime = 'nodejs'

/** POST — recognize fixed-price project revenue to the earned-to-date point
 *  (percent-complete). Optional { percentComplete: 0..1 } overrides cost-to-cost. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { percentComplete?: number }
  const pct = typeof body.percentComplete === 'number' ? body.percentComplete : undefined
  try {
    const result = await recognizeProjectRevenue(gate.user.orgId, gate.user.id, id, pct)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 })
  }
}
