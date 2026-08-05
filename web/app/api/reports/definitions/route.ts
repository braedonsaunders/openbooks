import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { validateCustomQuery, validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import { slugifyReportName, uniqueReportSlug } from '../../../../lib/custom-reports'

export const runtime = 'nodejs'

/** List report definitions for the org (built-in + custom). */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const rows = (await db.execute(sql`
    select id, kind, slug, name, description, query, updated_at
      from report_definitions
     where org_id = ${user.orgId}
     order by kind, name
  `)) as unknown as { rows: unknown[] }
  return NextResponse.json({ definitions: rows.rows })
}

/**
 * Create a custom definition. The query plan is validated through the engine
 * sanitiser (unknown entity/columns/operators rejected) before storage.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const body = (await req.json()) as {
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
  const layout = validateReportLayout(body.layout)
  const slug = await uniqueReportSlug(user.orgId, slugifyReportName(name))

  const inserted = (await db.execute(sql`
    insert into report_definitions (org_id, kind, slug, name, description, query, layout, created_by, updated_by)
    values (${user.orgId}, 'custom', ${slug}, ${name}, ${body.description?.trim() || null},
            ${JSON.stringify(query)}::jsonb, ${layout ? JSON.stringify(layout) : null}::jsonb,
            ${user.id}, ${user.id})
    returning id, kind, slug, name, description, query, updated_at
  `)) as unknown as { rows: { id: string }[] }

  return NextResponse.json({ definition: inserted.rows[0] }, { status: 201 })
}
