import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { delegateGate } from '@openbooks/engine/src/flows/index.ts'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { gateErrorResponse, loadGateHeader, requireFlowsSession } from '../../_lib'

export const runtime = 'nodejs'

/**
 * Hand a pending gate to another user in the org. The engine's delegateGate()
 * authorizes (current assignee or an org admin), verifies the target is an
 * active in-org user, records the hand-off, and notifies the new assignee —
 * the route only session-guards, org-scopes, and maps errors.
 */
export async function POST(req: Request) {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { gateId?: string; toUserId?: string }
  if (!body.gateId || !isUuid(body.gateId) || !body.toUserId || !isUuid(body.toUserId)) {
    return NextResponse.json({ error: 'gateId and toUserId required' }, { status: 400 })
  }

  const gate = await loadGateHeader(body.gateId, authz.user.orgId)
  if (!gate) return NextResponse.json({ error: 'approval not found' }, { status: 404 })
  const subsidiaryDenied = guardSubsidiaryScope(authz, gate.subsidiary_id)
  if (subsidiaryDenied) return subsidiaryDenied
  if (gate.status !== 'pending') {
    return NextResponse.json({ error: 'only a pending approval can be delegated' }, { status: 409 })
  }

  try {
    // The route 404s out-of-scope gates above; the engine re-checks the
    // same boundary inside the decision so a concurrent edit cannot race it.
    await delegateGate(
      body.gateId,
      authz.user.id,
      body.toUserId,
      authz.allowedSubsidiaryIds == null ? authz.allowedSubsidiaryIds : new Set(authz.allowedSubsidiaryIds),
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    return gateErrorResponse(e)
  }
}
