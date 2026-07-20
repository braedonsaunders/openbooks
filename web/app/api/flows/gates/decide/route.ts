import { NextResponse } from 'next/server'
import { decideGate } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, can } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { gateErrorResponse, loadGateHeader } from '../../_lib'

export const runtime = 'nodejs'

/**
 * Approve/reject one flow gate. Authorization is layered:
 *
 *   • route — session + org scoping (404 outside the caller's org), plus a
 *     coarse screen: the caller must hold `flows.approve` or be the row's
 *     direct assignee. Assignees always pass regardless of permissions.
 *   • engine — decideGate() is the source of truth: the row's assignee, an org
 *     admin, or an active delegate — and it refuses the submitter. The route
 *     never grants more than the engine allows and never blocks a legitimate
 *     assignee.
 */
export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    gateId?: string
    decision?: 'approved' | 'rejected'
    comment?: string
  }
  if (!body.gateId || !isUuid(body.gateId) || !['approved', 'rejected'].includes(body.decision ?? '')) {
    return NextResponse.json({ error: 'gateId and decision required' }, { status: 400 })
  }

  const gate = await loadGateHeader(body.gateId, authz.user.orgId)
  if (!gate) return NextResponse.json({ error: 'approval not found' }, { status: 404 })
  if (gate.status !== 'pending') {
    return NextResponse.json({ error: 'this approval was already resolved' }, { status: 409 })
  }
  const screened =
    can(authz, 'flows.approve') || gate.assignee_user_id === authz.user.id
  if (!screened) {
    return NextResponse.json({ error: 'you are not an approver for this gate' }, { status: 403 })
  }

  try {
    const res = await decideGate({
      gateId: body.gateId,
      decision: body.decision!,
      userId: authz.user.id,
      comment: body.comment,
    })
    return NextResponse.json(res)
  } catch (e) {
    return gateErrorResponse(e)
  }
}
