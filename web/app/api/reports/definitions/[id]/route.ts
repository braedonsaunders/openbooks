import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { validateCustomQuery, validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../../lib/authz'
import {
  loadReportDefinition,
  slugifyReportName,
  uniqueReportSlug,
} from '../../../../../lib/custom-reports'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const def = await loadReportDefinition(gate.user.orgId, id)
  if (!def) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ definition: def })
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

  const body = (await req.json()) as {
    name?: string
    description?: string | null
    query?: unknown
    layout?: unknown
  }

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
      queryJson = JSON.stringify(validateCustomQuery(body.query))
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid report query' },
        { status: 422 },
      )
    }
  }

  const layout =
    body.layout !== undefined ? validateReportLayout(body.layout) : existing.layout

  await db.execute(sql`
    update report_definitions set
      name = ${name},
      slug = ${slug},
      description = ${body.description !== undefined ? body.description?.trim() || null : existing.description},
      query = ${queryJson}::jsonb,
      layout = ${layout ? JSON.stringify(layout) : null}::jsonb,
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `)

  const def = await loadReportDefinition(user.orgId, id)
  return NextResponse.json({ definition: def })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const existing = await loadReportDefinition(user.orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.kind === 'built_in') {
    return NextResponse.json(
      { error: 'Built-in reports cannot be deleted — clone it instead.' },
      { status: 422 },
    )
  }

  // Schedules + runs cascade via the FK (report_schedules ON DELETE CASCADE,
  // report_runs.definition_id ON DELETE CASCADE).
  await db.execute(sql`delete from report_definitions where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
