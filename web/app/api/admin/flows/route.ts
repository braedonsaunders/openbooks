import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { emptyAutomationGraph } from '@openbooks/forms-core'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Flows collection — list with run stats, create with an empty graph.
 * The graph itself is edited through PATCH /api/admin/flows/[id].
 */

export async function GET() {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select f.id, f.name, f.description, f.subject_kind, f.enabled, f.updated_at,
           jsonb_array_length(f.graph->'nodes') as node_count,
           (select count(*) from flow_runs r where r.flow_id = f.id) as run_count,
           lr.status as last_run_status, lr.started_at as last_run_at
      from flows f
      left join lateral (
        select status, started_at from flow_runs r
         where r.flow_id = f.id order by r.started_at desc limit 1
      ) lr on true
     where f.org_id = ${gate.user.orgId}
     order by f.name
  `)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ flows: r.rows })
}

export async function POST(req: Request) {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const name = String(body.name ?? '').trim()
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const subjectKind = String(body.subjectKind ?? '')
  if (!listFlowSubjectProfiles().some((p) => p.subjectKind === subjectKind)) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 })
  }

  const r = (await db.execute(sql`
    insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
    values (${user.orgId}, ${name}, ${subjectKind}, false,
            ${JSON.stringify(emptyAutomationGraph())}::jsonb, ${user.id}, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}
