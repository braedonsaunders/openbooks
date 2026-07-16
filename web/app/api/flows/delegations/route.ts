import { NextResponse } from 'next/server'
import {
  createDelegation,
  listUserDelegations,
  revokeDelegation,
  DelegationError,
} from '@openbooks/engine/src/flows/index.ts'
import { getAuthz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

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

function delegationErrorResponse(e: unknown): NextResponse {
  if (e instanceof DelegationError) {
    const status = /not found/.test(e.message)
      ? 404
      : /already revoked|expired/.test(e.message)
        ? 409
        : 422
    return NextResponse.json({ error: e.message }, { status })
  }
  console.error('[flows] delegations endpoint failed:', e)
  return NextResponse.json({ error: 'internal error' }, { status: 500 })
}

export async function GET() {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const delegations = await listUserDelegations(authz.user.orgId, authz.user.id)
  return NextResponse.json({ delegations })
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    toUserId?: string
    startsAt?: string
    endsAt?: string
    reason?: string
  }
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
}

export async function PATCH(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { id?: string; revoke?: boolean }
  if (!body.id || !isUuid(body.id) || body.revoke !== true) {
    return NextResponse.json({ error: 'id and revoke:true required' }, { status: 400 })
  }
  try {
    await revokeDelegation(authz.user.orgId, body.id, authz.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return delegationErrorResponse(e)
  }
}

export async function DELETE(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    await revokeDelegation(authz.user.orgId, id, authz.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return delegationErrorResponse(e)
  }
}
