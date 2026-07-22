import { NextResponse } from 'next/server'
import { decideGate } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { gateErrorResponse, loadGateHeader } from '../../_lib'

export const runtime = 'nodejs'

/**
 * Approve/reject one flow gate. The route enforces session + org scoping (404
 * outside the caller's org) and the already-resolved fast path; decideGate() is
 * the SINGLE authority for who may decide — the row's assignee, an org admin, or
 * an active delegate, and it refuses the submitter. Authorization lives in one
 * place so the route and engine can't drift.
 */
export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    gateId?: string
    decision?: 'approved' | 'rejected'
    comment?: string
    signature?: string
  }
  if (!body.gateId || !isUuid(body.gateId) || !['approved', 'rejected'].includes(body.decision ?? '')) {
    return NextResponse.json({ error: 'gateId and decision required' }, { status: 400 })
  }

  const gate = await loadGateHeader(body.gateId, authz.user.orgId)
  if (!gate) return NextResponse.json({ error: 'approval not found' }, { status: 404 })
  if (gate.status !== 'pending') {
    return NextResponse.json({ error: 'this approval was already resolved' }, { status: 409 })
  }

  try {
    const res = await decideGate({
      gateId: body.gateId,
      decision: body.decision!,
      userId: authz.user.id,
      comment: body.comment,
      signature: body.signature,
    })
    return NextResponse.json(res)
  } catch (e) {
    return gateErrorResponse(e)
  }
}
