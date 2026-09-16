import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../../lib/authz'
import { listAgentRuns } from '../../../../../../lib/setup/agents'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/setup/agents/activity — run envelopes across packs, newest
 * first (`?agent=` filters to one pack, `?limit=` caps the list). Setup
 * managers only.
 */
export async function GET(request: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') ?? 50)
  const result = await listAgentRuns(gate.user.orgId, {
    agentKey: url.searchParams.get('agent') ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  })
  return NextResponse.json(result)
}
