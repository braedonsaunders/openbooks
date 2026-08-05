import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { createProjectCharge, ChargeError, type ChargeLineInput } from '../../../lib/project-charges'
import { guardProjectsFeature } from '../../../lib/projects-gate'

export const runtime = 'nodejs'

/** GET ?projectId= — list project_charge documents (+ their billed status). */
export async function GET(req: Request) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId || !isUuid(projectId)) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  const project = (await db.execute(sql`select subsidiary_id from projects where id = ${projectId} and org_id = ${gate.user.orgId}`)) as any
  if (!project.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(project.rows[0].subsidiary_id)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const r = (await db.execute(sql`
    select d.id, d.document_number as "documentNumber", d.document_date as "documentDate", d.status,
           d.total::numeric(19,4) as cost,
           coalesce(sum(coalesce(dl.bill_amount, dl.amount * coalesce(nullif(dl.cost_multiplier,0),1))) filter (where dl.is_billable), 0)::numeric(19,4) as "billValue",
           count(dl.*) as lines,
           bool_and(dl.billed_by_line_id is not null) filter (where dl.is_billable) as billed
      from documents d
      left join document_lines dl on dl.document_id = d.id
     where d.org_id = ${gate.user.orgId} and d.kind = 'project_charge' and d.project_id = ${projectId}
     group by d.id
     order by d.document_date desc, d.document_number desc
  `)) as unknown as { rows: any[] }
  return NextResponse.json({ charges: r.rows })
}

/** POST — create + post a project charge. */
export async function POST(req: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const body = (await req.json()) as { projectId?: string; referenceNumber?: string; lines?: ChargeLineInput[] }
  if (!body?.projectId || !isUuid(String(body.projectId))) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: 'At least one charge line is required' }, { status: 400 })
  }
  const project = (await db.execute(sql`select subsidiary_id from projects where id = ${body.projectId} and org_id = ${gate.user.orgId}`)) as any
  if (!project.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(project.rows[0].subsidiary_id)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  try {
    const created = await createProjectCharge(gate.user.orgId, gate.user.id, {
      projectId: body.projectId,
      referenceNumber: body.referenceNumber ?? null,
      lines: body.lines,
    })
    return NextResponse.json(created)
  } catch (e) {
    const status = e instanceof ChargeError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
