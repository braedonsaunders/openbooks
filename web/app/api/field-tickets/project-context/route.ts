import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { resolveTicketPeriod } from '../../../../lib/field-tickets'

export const runtime = 'nodejs'

/** Lightweight project context for the field-ticket project picker. */
export async function GET(req: Request) {
  const gate = await guardPermission('time.read')
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'fieldTickets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId || !isUuid(projectId)) return NextResponse.json({ error: 'invalid project' }, { status: 422 })

  const project = (await db.execute<{ id: string; customer_name: string | null }>(sql`
    select p.id, cust.display_name as customer_name
      from projects p
      left join parties cust on cust.id = p.customer_id and cust.org_id = p.org_id
     where p.id = ${projectId} and p.org_id = ${gate.user.orgId} and p.is_active
  `))
  if (!project.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const tasks = (await db.execute<Record<string, unknown>>(sql`
    select id, code, name, status, estimated_hours as "estimatedHours"
      from project_tasks
     where org_id = ${gate.user.orgId} and project_id = ${projectId}
     order by code nulls last, name
  `))

  return NextResponse.json({
    customerName: project.rows[0].customer_name,
    period: await resolveTicketPeriod(gate.user.orgId, projectId),
    tasks: tasks.rows,
  })
}
