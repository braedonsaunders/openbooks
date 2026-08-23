import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { validateCustomQuery, validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import { canRunReportEntity, canRunReportStatement, guardReportEntity } from '../../../../lib/report-authz'
import { slugifyReportName, uniqueReportSlug } from '../../../../lib/custom-reports'
import { ensureReportDefinitions } from '@openbooks/engine/src/ensure-report-definitions.ts'

export const runtime = 'nodejs'

/**
 * List report definitions for the org (built-in + custom).
 *
 * Filtered by the same entity gate the runner applies. Listing a payroll plan
 * to a reader who cannot run it leaks the catalog (names, descriptions and the
 * stored plan itself) and hands out the id that every execution path keys on.
 */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  await ensureReportDefinitions(user.orgId)
  const rows = (await db.execute<{ query: unknown; statement: { kind?: string } | null }>(sql`
    select id, kind, slug, name, description, query, statement, updated_at
      from report_definitions
     where org_id = ${user.orgId}
     order by kind, name
  `))
  const visible = []
  for (const row of rows.rows) {
    if (!(await canRunReportEntity(gate, row.query))) continue
    if (!(await canRunReportStatement(gate, row.statement?.kind))) continue
    visible.push(row)
  }
  return NextResponse.json({
    definitions: visible,
  })
}

/**
 * Create a custom definition. The query plan is validated through the engine
 * sanitiser (unknown entity/columns/operators rejected) before storage.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string
    description?: string | null
    query?: unknown
    layout?: unknown
  }
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A report name is required' }, { status: 422 })

  let query
  try {
    query = validateCustomQuery(body.query)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid report query' },
      { status: 422 },
    )
  }
  const denied = await guardReportEntity(gate, query)
  if (denied) return denied
  const layout = validateReportLayout(body.layout)
  const slug = await uniqueReportSlug(user.orgId, slugifyReportName(name))

  const inserted = (await db.execute<{ id: string }>(sql`
    insert into report_definitions (org_id, kind, slug, name, description, query, layout, created_by, updated_by)
    values (${user.orgId}, 'custom', ${slug}, ${name}, ${body.description?.trim() || null},
            ${JSON.stringify(query)}::jsonb, ${layout ? JSON.stringify(layout) : null}::jsonb,
            ${user.id}, ${user.id})
    returning id, kind, slug, name, description, query, updated_at
  `))

  return NextResponse.json({ definition: inserted.rows[0] }, { status: 201 })
}
