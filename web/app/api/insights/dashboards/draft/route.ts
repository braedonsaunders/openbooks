import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { mutateInsight } from '@/lib/insight-mutations'
import { insightDashboards } from '@openbooks/schema/src/insights.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/** Instant-into-draft dashboard: create it server-side and return its id. */
export async function POST() {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const id = randomUUID()
  return mutateInsight(gate, 'insight_dashboards', id, 'insert', async (tx) => {
    const [dashboard] = await tx
      .insert(insightDashboards)
      .values({
        id,
        orgId: user.orgId,
        name: 'Untitled dashboard',
        layout: [],
        status: 'draft',
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning({ id: insightDashboards.id })

    return NextResponse.json(dashboard)
  })
}
