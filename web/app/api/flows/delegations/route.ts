import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import {
  createDelegation,
  listUserDelegations,
  revokeDelegation,
  DelegationError,
} from '@openbooks/engine/src/flows/index.ts'
import { requireFlowsSession } from '../_lib'
import { isUuid } from '../../../../lib/list-params'

const createDelegationBodySchema = z.object({
  toUserId: z.string().uuid(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().max(500).optional(),
});
const revokeDelegationBodySchema = z.object({ id: z.string().uuid(), revoke: z.literal(true) });


export const runtime = 'nodejs'

/**
 * Out-of-office approval delegations — self-service, session-gated (no extra
 * permission: delegating your own approvals is like acting on your own gates,
 * the gate assignment is the grant and delegation never exceeds it).
 *
 *   GET             my active + upcoming delegations, both directions
 *   POST            { toUserId, startsAt, endsAt, reason? } → create
 *   PATCH           { id, revoke: true } → revoke one of mine
 *   DELETE ?id=     same as PATCH revoke
 */

function delegationErrorResponse(e: unknown): Promise<NextResponse> {
  if (e instanceof DelegationError) {
    const status = /not found/.test(e.message)
      ? 404
      : /already revoked|expired/.test(e.message)
        ? 409
        : 422
    return apiErrorResponse(e, { safeStatus: status })
  }
  console.error('[flows] delegations endpoint failed:', e)
  return Promise.resolve(NextResponse.json({ error: 'internal error' }, { status: 500 }))
}

async function legacyGET() {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz
  const delegations = await listUserDelegations(authz.user.orgId, authz.user.id)
  return NextResponse.json({ delegations })
}





async function legacyDELETE(req: Request) {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz
  const id = new URL(req.url).searchParams.get('id')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    await revokeDelegation(authz.user.orgId, id, authz.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return delegationErrorResponse(e)
  }
}

export const GET = defineRoute({
  public: "session",
  handler: async () => legacyGET(),
});

export const POST = defineRoute({
  public: "session",
  body: createDelegationBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const authz = routeAuthz





    if (!body.toUserId || !isUuid(body.toUserId)) {
      return NextResponse.json({ error: 'toUserId required' }, { status: 400 })
    }
    const startsAt = body.startsAt ? new Date(body.startsAt) : null
    const endsAt = body.endsAt ? new Date(body.endsAt) : null
    if (!startsAt || Number.isNaN(startsAt.getTime()) || !endsAt || Number.isNaN(endsAt.getTime())) {
      return NextResponse.json({ error: 'valid startsAt and endsAt required' }, { status: 400 })
    }

    try {
      const { delegation, overlapping } = await createDelegation({
        orgId: authz.user.orgId,
        fromUserId: authz.user.id,
        toUserId: body.toUserId,
        startsAt,
        endsAt,
        reason: body.reason,
      })
      // Overlaps are allowed (two delegates can cover the same window) but
      // surfaced so the UI can note it.
      return NextResponse.json({ delegation, overlapping }, { status: 201 })
    } catch (e) {
      return delegationErrorResponse(e)
    }
  },

  feature: "flows",});

export const PATCH = defineRoute({
  public: "session",
  body: revokeDelegationBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const authz = routeAuthz




    if (!body.id || !isUuid(body.id) || body.revoke !== true) {
      return NextResponse.json({ error: 'id and revoke:true required' }, { status: 400 })
    }
    try {
      await revokeDelegation(authz.user.orgId, body.id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      return delegationErrorResponse(e)
    }
  },

  feature: "flows",});

export const DELETE = defineRoute({
  public: "session",
  handler: async ({ request }) => legacyDELETE(request as never),
});
