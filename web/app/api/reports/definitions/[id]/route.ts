import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { isDocumentRevisionToken } from '../../../../../lib/api/registry-data'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { validateCustomQuery, validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../../lib/authz'
import { canAccessReportDefinition } from '../../../../../lib/report-execution-context'
import { canRunReportEntity, canRunReportStatement, guardReportEntity } from '../../../../../lib/report-authz'
import {
  loadReportDefinition,
  slugifyReportName,
  uniqueReportSlug,
} from '../../../../../lib/custom-reports'

export const runtime = 'nodejs'

const REPORT_DEFINITION_REVISION = sql`to_char(
  updated_at at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`

async function loadReportDefinitionRevision(orgId: string, id: string): Promise<string | null> {
  const result = await db.execute<{ updated_at: string }>(sql`
    select ${REPORT_DEFINITION_REVISION} as updated_at
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `)
  return result.rows[0]?.updated_at ?? null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const def = await loadReportDefinition(gate.user.orgId, id)
  if (!def) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await canRunReportEntity(gate, def.query))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await canRunReportStatement(gate, def.statement?.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // node-postgres maps timestamptz to Date and drops PostgreSQL's
  // microseconds. Return the exact wire revision so an autosave can use it as
  // an optimistic-concurrency precondition without authorizing a lossy token.
  const updatedAt = await loadReportDefinitionRevision(gate.user.orgId, id)
  return NextResponse.json({ definition: { ...def, updated_at: updatedAt ?? def.updated_at } })
}

/**
 * Autosave/save for a definition. Built-ins are name/query-editable in place
 * too (an org may tune a seeded plan), but the kind is never changed here.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const existing = await loadReportDefinition(user.orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await canAccessReportDefinition(gate, existing))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string
    description?: string | null
    query?: unknown
    layout?: unknown
    expectedUpdatedAt?: unknown
  }

  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json(
      { error: 'the report definition revision is required; reload and review the latest revision' },
      { status: 409 },
    )
  }
  const expectedUpdatedAt = body.expectedUpdatedAt

  let name = existing.name
  let slug = existing.slug
  if (typeof body.name === 'string') {
    name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'A report name is required' }, { status: 422 })
    if (name !== existing.name) {
      slug = await uniqueReportSlug(user.orgId, slugifyReportName(name), id)
    }
  }

  let queryJson = JSON.stringify(existing.query)
  if (body.query !== undefined) {
    try {
      const query = validateCustomQuery(body.query)
      const denied = await guardReportEntity(gate, query)
      if (denied) return denied
      queryJson = JSON.stringify(query)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid report query' },
        { status: 422 },
      )
    }
  }

  const layout =
    body.layout !== undefined ? validateReportLayout(body.layout) : existing.layout

  const updated = await db.execute<{ id: string }>(sql`
    update report_definitions set
      name = ${name},
      slug = ${slug},
      description = ${body.description !== undefined ? body.description?.trim() || null : existing.description},
      query = ${queryJson}::jsonb,
      layout = ${layout ? JSON.stringify(layout) : null}::jsonb,
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
      and ${REPORT_DEFINITION_REVISION} = ${expectedUpdatedAt}
    returning id
  `)

  if (!updated.rows[0]) {
    return NextResponse.json(
      { error: 'this report definition changed after you opened it; reload and review the latest revision' },
      { status: 409 },
    )
  }

  const def = await loadReportDefinition(user.orgId, id)
  const updatedAt = await loadReportDefinitionRevision(user.orgId, id)
  return NextResponse.json({ definition: def ? { ...def, updated_at: updatedAt ?? def.updated_at } : def })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const existing = await loadReportDefinition(user.orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await canAccessReportDefinition(gate, existing))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
  if (existing.kind === 'built_in') {
    return NextResponse.json(
      { error: 'Built-in reports cannot be deleted — clone it instead.' },
      { status: 422 },
    )
  }

  // Schedules + runs cascade via their FKs. Capture their counts and the exact
  // deleted definition in the immutable audit log in the same transaction so
  // a deletion can never occur without its evidence.
  const deleted = await db.transaction(async (tx) => {
    const dependents = (await tx.execute<{ schedule_count: string; run_count: string }>(sql`
      select
        (select count(*)::text from report_schedules
          where org_id = ${user.orgId} and definition_id = ${id}) as schedule_count,
        (select count(*)::text from report_runs
          where org_id = ${user.orgId} and definition_id = ${id}) as run_count
    `))

    const result = (await tx.execute<Record<string, unknown>>(sql`
      delete from report_definitions
       where id = ${id} and org_id = ${user.orgId} and kind = 'custom'
       returning id, kind, report_type, slug, name, description, query, statement,
                 system, layout, created_at, updated_at, created_by, updated_by
    `))
    const snapshot = result.rows[0]
    if (!snapshot) return null

    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${user.orgId},
        'report_definitions',
        ${id},
        'delete',
        ${JSON.stringify({
          before: snapshot,
          after: null,
          cascaded: {
            schedules: Number(dependents.rows[0]?.schedule_count ?? 0),
            runs: Number(dependents.rows[0]?.run_count ?? 0),
          },
        })}::jsonb,
        ${user.id}
      )
    `)
    return snapshot
  })

  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
