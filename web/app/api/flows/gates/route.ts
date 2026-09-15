import { NextResponse } from 'next/server'
import { worklistGates } from '@openbooks/engine/src/flows/index.ts'
import { requireFlowsSession } from '../_lib'

export const runtime = 'nodejs'

/**
 * My pending flow approval gates: rows assigned to me directly or to a role I
 * hold. No permission gate beyond a session — a gate assignment IS the grant
 * (assignees can always act on their own gates), so any signed-in user may
 * list what is waiting on them.
 */
export async function GET() {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz
  // A gate assignment is not a grant to every legal entity: the worklist
  // carries the same subsidiary boundary the decide path enforces, so
  // financial details from other entities are never listed.
  const gates = await worklistGates(
    authz.user.orgId,
    authz.user.id,
    undefined,
    authz.allowedSubsidiaryIds,
  )
  return NextResponse.json({ gates })
}
