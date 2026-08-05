import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { automationGraphSchema } from '@openbooks/forms-core'
import { flowSubjectProfileForOrg, lintFlowGraphForSubject } from '@openbooks/engine/src/flows/index.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * One flow — read (with recent runs), rename/describe/enable/save-graph,
 * delete (with its run history).
 *
 * Graph saves are validated in two tiers:
 *   • STRUCTURAL (zod graph schema — malformed nodes/edges/caps) → 400
 *     {errors}; nothing is written.
 *   • VOCABULARY / wiring lints (lintFlowGraphForSubject: unreachable nodes,
 *     unknown fields/statuses, worker-trigger compatibility, …) → the graph
 *     still saves (authors keep work-in-progress) and the lints come back as
 *     {warnings} for the builder to surface non-blocking.
 */

type Params = { params: Promise<{ id: string }> }

async function loadFlow(orgId: string, id: string) {
  if (!isUuid(id)) return null
  const r = (await db.execute(sql`
    select * from flows where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  return r.rows[0] ?? null
}

export async function GET(_req: Request, { params }: Params) {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const flow = await loadFlow(gate.user.orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const runs = (await db.execute(sql`
    select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
      from flow_runs where flow_id = ${id} and org_id = ${gate.user.orgId}
     order by started_at desc limit 30
  `)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ flow, runs: runs.rows })
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  const flow = await loadFlow(user.orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const sets = [sql`updated_at = now()`, sql`updated_by = ${user.id}`]

  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name || name.length > 200) {
      return NextResponse.json({ errors: ['name required (max 200 chars)'] }, { status: 400 })
    }
    sets.push(sql`name = ${name}`)
  }
  if (body.description !== undefined) {
    sets.push(sql`description = ${body.description === null ? null : String(body.description)}`)
  }
  if (body.enabled !== undefined) {
    sets.push(sql`enabled = ${Boolean(body.enabled)}`)
  }

  let warnings: string[] = []
  if (body.graph !== undefined) {
    // Structural gate: a graph the executor cannot even parse is rejected.
    const parsed = automationGraphSchema.safeParse(body.graph)
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`)
      return NextResponse.json({ errors }, { status: 400 })
    }
    // Author-time lints are non-blocking: report, but store positions as-is.
    const profile = await flowSubjectProfileForOrg(user.orgId, String(flow.subject_kind))
    const lint = lintFlowGraphForSubject(String(flow.subject_kind), parsed.data, profile ?? undefined)
    warnings = lint.ok ? [] : lint.errors
    sets.push(sql`graph = ${JSON.stringify(parsed.data)}::jsonb`)
  }

  // Drafts may retain authoring warnings, but an enabled flow must be fully
  // executable against the tenant's current roles and custom fields.
  if (body.enabled === true) {
    const candidateGraph = body.graph ?? flow.graph
    const profile = await flowSubjectProfileForOrg(user.orgId, String(flow.subject_kind))
    const lint = lintFlowGraphForSubject(
      String(flow.subject_kind),
      candidateGraph,
      profile ?? undefined,
    )
    if (!lint.ok) return NextResponse.json({ errors: lint.errors }, { status: 400 })
  }

  await db.execute(sql`
    update flows set ${sql.join(sets, sql`, `)}
     where id = ${id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true, warnings })
}

export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const { id } = await params
  const flow = await loadFlow(orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Explicit child cleanup (gates → effects → runs → flow) inside one
  // transaction, so the delete works even before the cascade FKs land.
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from flow_gates where flow_id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      delete from flow_run_effects where org_id = ${orgId}
        and run_id in (select id from flow_runs where flow_id = ${id} and org_id = ${orgId})`)
    await tx.execute(sql`delete from flow_runs where flow_id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`delete from flows where id = ${id} and org_id = ${orgId}`)
  })
  return NextResponse.json({ ok: true })
}
