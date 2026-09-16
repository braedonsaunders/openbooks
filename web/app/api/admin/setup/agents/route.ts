import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { getAgentsOverview } from '../../../../../lib/setup/agents'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/setup/agents — one overview row per registered pack (policy,
 * last run, open findings). Setup managers only; the provider page keeps its
 * own read path.
 */
export async function GET() {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ agents: await getAgentsOverview(gate.user.orgId) })
}
