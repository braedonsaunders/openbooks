import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { documentRevisionSql } from '@openbooks/engine/src/records/revision.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { emptyAutomationGraph } from '@openbooks/forms-core'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { filterFlowRunSubjectsToScope } from '../../flows/_lib'

export const runtime = 'nodejs'

/**
 * Flows collection — list with run stats, create with an empty graph.
 * The graph itself is edited through PATCH /api/admin/flows/[id].
 */

export async function GET() {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  if (gate.allowedSubsidiaryIds === null) {
    const r = (await db.execute<Record<string, unknown>>(sql`
      select f.id, f.name, f.description, f.subject_kind, f.enabled, ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
             jsonb_array_length(f.graph->'nodes') as node_count,
             (select count(*) from flow_runs r where r.flow_id = f.id and r.org_id = f.org_id) as run_count,
             lr.status as last_run_status, lr.started_at as last_run_at
        from flows f
        left join lateral (
          select status, started_at from flow_runs r
           where r.flow_id = f.id and r.org_id = f.org_id order by r.started_at desc limit 1
        ) lr on true
       where f.org_id = ${gate.user.orgId}
       order by f.name
    `))
    return NextResponse.json({ flows: r.rows })
  }
  // A subsidiary-restricted caller must not learn org-wide run counts or
  // last-run verdicts: the counts and last-run fields below are computed
  // over in-scope subjects only, with the same subject rule the retry
  // route enforces per run.
  const [flows, runs] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select f.id, f.name, f.description, f.subject_kind, f.enabled,
             ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
             jsonb_array_length(f.graph->'nodes') as node_count
        from flows f
       where f.org_id = ${gate.user.orgId}
       order by f.name
    `),
    db.execute<{ flowId: string; status: string; startedAt: Date; kind: string; id: string }>(sql`
      select flow_id as "flowId", status, started_at as "startedAt",
             subject_kind as kind, subject_id as id
        from flow_runs
       where org_id = ${gate.user.orgId}
    `),
  ])
  const visible = await filterFlowRunSubjectsToScope(
    gate.user.orgId,
    gate.allowedSubsidiaryIds,
    runs.rows,
  )
  const byFlow = new Map<string, typeof runs.rows>()
  for (const run of visible) {
    const list = byFlow.get(run.flowId) ?? []
    list.push(run)
    byFlow.set(run.flowId, list)
  }
  return NextResponse.json({
    flows: flows.rows.map((flow) => {
      const scoped = (byFlow.get(String(flow.id)) ?? [])
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      return {
        ...flow,
        run_count: String(scoped.length),
        last_run_status: scoped[0]?.status ?? null,
        last_run_at: scoped[0]?.startedAt ?? null,
      }
    }),
  })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>

  const name = String(body.name ?? '').trim()
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const subjectKind = String(body.subjectKind ?? '')
  if (!listFlowSubjectProfiles().some((p) => p.subjectKind === subjectKind)) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 })
  }

  const id = await db.transaction(async (tx) => {
    const r = (await tx.execute<{ id: string }>(sql`
      insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
      values (${user.orgId}, ${name}, ${subjectKind}, false,
              ${JSON.stringify(emptyAutomationGraph())}::jsonb, ${user.id}, ${user.id})
      returning *
    `))
    const created = r.rows[0]!
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${user.orgId}, 'flows', ${created.id}, 'insert',
         ${JSON.stringify({ after: created })}::jsonb,
         ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return created.id
  })
  return NextResponse.json({ id })
}
