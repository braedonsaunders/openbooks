import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { jsonObject, parseJsonBody, validateJsonBody } from "@/lib/api/json";

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { automationGraphSchema } from '@openbooks/forms-core'
import { flowSubjectProfileForOrg, lintFlowGraphForSubject } from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

import { filterFlowRunSubjectsToScope } from '../../../flows/_lib'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  "description": z.string().optional(),
  "enabled": z.boolean().optional(),
  "expectedUpdatedAt": z.string().optional(),
  "graph": automationGraphSchema.optional(),
  "name": z.string().optional(),
});



export const runtime = 'nodejs'

/**
 * One flow — read (with recent runs), rename/describe/enable/save-graph,
 * delete unused definitions while preserving execution history.
 *
 * Graph saves are validated in two tiers:
 *   • STRUCTURAL (zod graph schema — malformed nodes/edges/caps) → 400
 *     field issues; nothing is written.
 *   • VOCABULARY / wiring lints (lintFlowGraphForSubject: unreachable nodes,
 *     triggers without an outgoing step, unknown fields/statuses,
 *     worker-trigger compatibility, …) → the graph still saves (authors keep
 *     work-in-progress) and the lints come back as {warnings} for the
 *     builder to surface non-blocking.
 */

type Params = { params: Promise<{ id: string }> }

async function loadFlow(orgId: string, id: string) {
  if (!isUuid(id)) return null
  const r = (await db.execute<Record<string, unknown>>(sql`
    select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at from flows where id = ${id} and org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

async function legacyGET(_req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const flow = await loadFlow(gate.user.orgId, id)
  if (!flow) return notFound("record")
  const runs = (await db.execute<Record<string, unknown>>(sql`
    select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
      from flow_runs where flow_id = ${id} and org_id = ${gate.user.orgId}
     order by started_at desc limit 30
  `))
  // A subsidiary-restricted flows.manage caller sees only runs whose
  // subject sits inside their scope — the same subject rule the retry
  // route enforces per run. Out-of-scope runs (and their subject UUIDs,
  // errors and timestamps) are dropped, never redacted in place.
  const visibleRuns = await filterFlowRunSubjectsToScope(
    gate.user.orgId,
    gate.allowedSubsidiaryIds,
    runs.rows.map((row) => ({
      kind: String(row.subject_kind),
      id: String(row.subject_id),
      row,
    })),
    gate,
  )
  return NextResponse.json({ flow, runs: visibleRuns.map((subject) => subject.row) })
}



function revisionConflict() {
  return NextResponse.json({ error: 'The flow has changed. Reload it before saving or deleting.' }, { status: 409 })
}



export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params }) => legacyGET(request as never, { params: Promise.resolve(params as never) } as never),
});

export const PATCH = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params, authz: routeAuthz }) => {

    const gate = routeAuthz



    const user = gate.user
    const { id } = params
    if (!isUuid(id)) return notFound("record")
    const rawBody = await parseJsonBody(request, jsonObject)
    if (!rawBody.ok) return rawBody.response
    const expectedUpdatedAt = rawBody.data.expectedUpdatedAt
    if (!isDocumentRevisionToken(expectedUpdatedAt)) return revisionConflict()
    const parsedBody = validateJsonBody(rawBody.data, requestBodySchema)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data



    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200)) {
      return NextResponse.json({ errors: ['name required (max 200 chars)'] }, { status: 400 })
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string or null' }, { status: 400 })
    }
    return db.transaction(async (tx) => {
      const flow = (await tx.execute<Record<string, unknown>>(sql`
        select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
          from flows where id = ${id} and org_id = ${user.orgId} for update
      `)).rows[0]
      if (!flow) return notFound("record")
      if (flow.updated_at !== expectedUpdatedAt) return revisionConflict()
      const sets = [sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')`, sql`updated_by = ${user.id}`]
      if (typeof body.name === 'string') sets.push(sql`name = ${body.name.trim()}`)
      if (body.description !== undefined) sets.push(sql`description = ${body.description}`)
      if (body.enabled !== undefined) sets.push(sql`enabled = ${body.enabled}`)

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

      const updated = (await tx.execute<Record<string, unknown>>(sql`
        update flows set ${sql.join(sets, sql`, `)}
         where id = ${id} and org_id = ${user.orgId}
         returning flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
      `))
      if (!updated.rows[0]) throw new Error('flow_changed')
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${user.orgId}, 'flows', ${id}, 'update',
           ${JSON.stringify({ before: flow, after: updated.rows[0] })}::jsonb,
           ${user.id}, ${request.headers.get('X-Request-Id')})
      `)
      return NextResponse.json({ ok: true, warnings, updatedAt: updated.rows[0].updated_at })
    })
  },
});

export const DELETE = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params, authz: routeAuthz }) => {

    const gate = routeAuthz



    const orgId = gate.user.orgId
    const { id } = params
    if (!isUuid(id)) return notFound("record")
    const rawBody = await parseJsonBody(request, jsonObject)
    if (!rawBody.ok) return rawBody.response
    const expectedUpdatedAt = rawBody.data.expectedUpdatedAt
    if (!isDocumentRevisionToken(expectedUpdatedAt)) return revisionConflict()
    const parsedBody = validateJsonBody(rawBody.data, requestBodySchema)
    if (!parsedBody.ok) return parsedBody.response

    return db.transaction(async (tx) => {
      // Lock the parent before checking children. Run/gate inserts take a foreign-key
      // key-share lock, so approvals cannot arrive between the check and deletion.
      const flow = (await tx.execute<Record<string, unknown>>(sql`
        select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
          from flows where id = ${id} and org_id = ${orgId} for update
      `)).rows[0]
      if (!flow) return notFound("record")
      if (flow.updated_at !== expectedUpdatedAt) return revisionConflict()
      const history = (await tx.execute<{ used: boolean }>(sql`
        select exists(select 1 from flow_runs where flow_id = ${id} and org_id = ${orgId})
            or exists(select 1 from flow_gates where flow_id = ${id} and org_id = ${orgId}) as used
      `)).rows[0]
      if (history?.used) return NextResponse.json({
        error: 'This flow has execution or approval history. Disable it to preserve that history.'
      }, { status: 409 })
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${orgId}, 'flows', ${id}, 'delete',
           ${JSON.stringify({ before: flow })}::jsonb,
           ${gate.user.id}, ${request.headers.get('X-Request-Id')})
      `)
      await tx.execute(sql`delete from flows where id = ${id} and org_id = ${orgId}`)
      return NextResponse.json({ ok: true })
    })
  },
});
