import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { automationGraphSchema } from '@openbooks/forms-core'
import { flowSubjectProfileForOrg, lintFlowGraphForSubject } from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
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
  const r = (await db.execute<Record<string, unknown>>(sql`
    select * from flows where id = ${id} and org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

export async function GET(_req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const flow = await loadFlow(gate.user.orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const runs = (await db.execute<Record<string, unknown>>(sql`
    select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
      from flow_runs where flow_id = ${id} and org_id = ${gate.user.orgId}
     order by started_at desc limit 30
  `))
  return NextResponse.json({ flow, runs: runs.rows })
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  const flow = await loadFlow(user.orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>

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
  // executable against the tenant's current roles and custom fields. The
  // blocking lint applies whenever the save leaves the flow ENABLED — an
  // explicit enable, or any save to an already-enabled flow (otherwise a
  // graph edit could smuggle change_status→approved nodes past the
  // engine-managed-release invariant as mere warnings). A flow being disabled,
  // or a draft, stays warning-only so authoring keeps its work-in-progress.
  const willBeEnabled =
    body.enabled === undefined ? Boolean(flow.enabled) : Boolean(body.enabled)
  if (willBeEnabled) {
    const candidateGraph = body.graph ?? flow.graph
    const profile = await flowSubjectProfileForOrg(user.orgId, String(flow.subject_kind))
    const lint = lintFlowGraphForSubject(
      String(flow.subject_kind),
      candidateGraph,
      profile ?? undefined,
    )
    if (!lint.ok) return NextResponse.json({ errors: lint.errors }, { status: 400 })
  }

  await db.transaction(async (tx) => {
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update flows set ${sql.join(sets, sql`, `)}
       where id = ${id} and org_id = ${user.orgId}
       returning *
    `))
    if (!updated.rows[0]) throw new Error('flow_changed')
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${user.orgId}, 'flows', ${id}, 'update',
         ${JSON.stringify({ before: flow, after: updated.rows[0] })}::jsonb,
         ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
  })
  return NextResponse.json({ ok: true, warnings })
}

export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const { id } = await params
  const flow = await loadFlow(orgId, id)
  if (!flow) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Fail closed: a flow with open approvals cannot be deleted. Wiping its
  // gates would leave subjects stuck in pending_approval — invisible in
  // approvals, uneditable and unpostable, with no release path. Escalated rows
  // count as open too (same definition as the engine's gate accounting).
  const open = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_gates
     where flow_id = ${id} and org_id = ${orgId} and status in ('pending', 'escalated')
  `))
  const openGates = open.rows[0]?.n ?? 0
  if (openGates > 0) {
    return NextResponse.json(
      {
        error:
          `this flow still has ${openGates} open approval${openGates === 1 ? '' : 's'} — ` +
          'resolve or recall the pending approvals before deleting the flow',
      },
      { status: 409 },
    )
  }

  // Explicit child cleanup (gates → effects → runs → flow) inside one
  // transaction, so the delete works even before the cascade FKs land. Flows
  // have no soft-delete column, so the full definition — the row, every gate
  // it ever created, and the run-history summary — is captured in the audit
  // payload before the cascade destroys it (the audit log is append-only).
  await db.transaction(async (tx) => {
    const gates = (await tx.execute<Record<string, unknown>>(sql`
      select * from flow_gates where flow_id = ${id} and org_id = ${orgId}
    `))
    const runs = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from flow_runs where flow_id = ${id} and org_id = ${orgId}
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${orgId}, 'flows', ${id}, 'delete',
         ${JSON.stringify({
           before: flow,
           gates: gates.rows,
           runsDeleted: runs.rows[0]?.n ?? 0,
         })}::jsonb,
         ${gate.user.id}, ${_req.headers.get('X-Request-Id')})
    `)
    await tx.execute(sql`delete from flow_gates where flow_id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      delete from flow_run_effects where org_id = ${orgId}
        and run_id in (select id from flow_runs where flow_id = ${id} and org_id = ${orgId})`)
    await tx.execute(sql`delete from flow_runs where flow_id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`delete from flows where id = ${id} and org_id = ${orgId}`)
  })
  return NextResponse.json({ ok: true })
}
