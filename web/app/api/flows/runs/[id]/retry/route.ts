import { NextResponse } from 'next/server'
import { retryFlowRun, FlowRetryError } from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Re-drive a FAILED flow run after its failure cause is fixed (F-t04-004: a
 * gate that resolved to zero assignees strands its subject with no path
 * forward). Retrying re-plans the stored trigger against the current graph
 * and current subject values on the same run row. Refusals are request
 * state (FlowRetryError → 4xx), never 500s.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const result = await retryFlowRun(id, { orgId: gate.user.orgId, userId: gate.user.id })
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof FlowRetryError) {
      const status = /not found/.test(e.message) ? 404 : 422
      return NextResponse.json({ error: e.message }, { status })
    }
    throw e
  }
}
