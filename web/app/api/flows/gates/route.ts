import { NextResponse } from 'next/server'
import { worklistGates } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * My pending flow approval gates: rows assigned to me directly or to a role I
 * hold. No permission gate beyond a session — a gate assignment IS the grant
 * (assignees can always act on their own gates), so any signed-in user may
 * list what is waiting on them.
 */
export async function GET() {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const gates = await worklistGates(authz.user.orgId, authz.user.id)
  return NextResponse.json({ gates })
}
