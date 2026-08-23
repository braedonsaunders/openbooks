import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { insightDashboardPins } from '@openbooks/schema/src/insights.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadDashboard } from '../../../_lib'

export const runtime = 'nodejs'

/**
 * Toggle a personal pin for the current user. Pinned dashboards are what the
 * home surface offers a user via <DashboardEmbed/>. `{ pin: false }` unpins.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.read')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const dashboard = await loadDashboard(id, user.orgId)
  if (!dashboard) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { pin?: boolean }
  const pin = body.pin !== false

  if (!pin) {
    await db.execute(sql`
      delete from insight_dashboard_pins
       where org_id = ${user.orgId} and user_id = ${user.id} and dashboard_id = ${id}
    `)
    return NextResponse.json({ pinned: false })
  }

  const next = (await db.execute<{ n: number }>(sql`
    select coalesce(max(sort_order), -1) + 1 as n
      from insight_dashboard_pins
     where org_id = ${user.orgId} and user_id = ${user.id}
  `))

  await db
    .insert(insightDashboardPins)
    .values({
      orgId: user.orgId,
      userId: user.id,
      dashboardId: id,
      sortOrder: Number(next.rows[0]?.n ?? 0),
    })
    .onConflictDoNothing()

  return NextResponse.json({ pinned: true })
}
