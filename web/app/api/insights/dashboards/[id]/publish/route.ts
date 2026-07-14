import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadDashboard } from '../../../_lib'

export const runtime = 'nodejs'

/** Publish / unpublish a dashboard. Publishing requires a real name. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.publish')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const dashboard = await loadDashboard(id, user.orgId)
  if (!dashboard) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { publish?: boolean }
  const publish = body.publish !== false

  if (publish && (!dashboard.name || dashboard.name.trim() === '' || dashboard.name === 'Untitled dashboard')) {
    return NextResponse.json({ error: 'Give the dashboard a real name before publishing.' }, { status: 422 })
  }

  await db.execute(sql`
    update insight_dashboards
       set status = ${publish ? 'published' : 'draft'}, updated_at = now(), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)

  const updated = await loadDashboard(id, user.orgId)
  return NextResponse.json(updated)
}
