import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/src/db.ts'
import { insightDashboards } from '@openbooks/schema/src/insights.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/** Instant-into-draft dashboard: create it server-side and return its id. */
export async function POST() {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const [dashboard] = await db
    .insert(insightDashboards)
    .values({
      orgId: user.orgId,
      name: 'Untitled dashboard',
      layout: [],
      status: 'draft',
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: insightDashboards.id })

  return NextResponse.json(dashboard)
}
