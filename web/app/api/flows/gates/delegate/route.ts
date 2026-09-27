import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'
import { delegateGate } from '@openbooks/engine/src/flows/index.ts'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { gateErrorResponse, loadGateHeader } from '../../_lib'

const requestBodySchema = z.object({ gateId: z.string().uuid(), toUserId: z.string().uuid() });


export const runtime = 'nodejs'

/**
 * Hand a pending gate to another user in the org. The engine's delegateGate()
 * authorizes (current assignee or an org admin), verifies the target is an
 * active in-org user, records the hand-off, and notifies the new assignee —
 * the route only session-guards, org-scopes, and maps errors.
 */


export const POST = defineRoute({
  public: "session",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const authz = routeAuthz





    if (!body.gateId || !isUuid(body.gateId) || !body.toUserId || !isUuid(body.toUserId)) {
      return NextResponse.json({ error: 'gateId and toUserId required' }, { status: 400 })
    }

    const gate = await loadGateHeader(body.gateId, authz.user.orgId, authz.allowedSubsidiaryIds)
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
  },

  feature: "flows",});
