import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'
import { decideGate } from '@openbooks/engine/src/flows/index.ts'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { gateErrorResponse, loadGateHeader } from '../../_lib'

const requestBodySchema = z.object({
  gateId: z.string().uuid(), decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(2000).optional(), signature: z.string().max(400_000).optional(),
});


export const runtime = 'nodejs'

/**
 * Approve/reject one flow gate. The route enforces session + org scoping (404
 * outside the caller's org) and the already-resolved fast path; decideGate() is
 * the SINGLE authority for who may decide — the row's assignee, an org admin, or
 * an active delegate, and it refuses the submitter. Authorization lives in one
 * place so the route and engine can't drift.
 */


export const POST = defineRoute({
  public: "session",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const authz = routeAuthz





    if (!body.gateId || !isUuid(body.gateId) || !['approved', 'rejected'].includes(body.decision ?? '')) {
      return NextResponse.json({ error: 'gateId and decision required' }, { status: 400 })
    }

    const gate = await loadGateHeader(body.gateId, authz.user.orgId, authz.allowedSubsidiaryIds)
    if (!gate) return NextResponse.json({ error: 'approval not found' }, { status: 404 })
    // A gate assignment is not a grant to every legal entity. Keep the same
    // direct-record subsidiary boundary as the rest of the API before allowing
    // the engine to resume a consequential branch.
    const subsidiaryDenied = guardSubsidiaryScope(authz, gate.subsidiary_id)
    if (subsidiaryDenied) return subsidiaryDenied
    if (gate.status !== 'pending') {
      return NextResponse.json({ error: 'this approval was already resolved' }, { status: 409 })
    }

    try {
      // decideGate either records the decision and completes its branch, or
      // throws: ANY post-flip failure rolls the whole decide unit back to its
      // savepoint (DecisionFailedError — decision NOT recorded, gate still
      // pending, retry the decision). gateErrorResponse maps a retryable
      // domain failure (a typed refusal from the release, e.g. the
      // approver's missing person link) to a 422 with the cause and remedy
      // intact — 409 for stale state, 503 for an infrastructure failure,
      // 500 only for a defect in the decide path.
      const res = await decideGate({
        gateId: body.gateId,
        decision: body.decision!,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        comment: body.comment,
        signature: body.signature,
      })
      return NextResponse.json(res)
    } catch (e) {
      return gateErrorResponse(e)
    }
  },

  feature: "flows",});
