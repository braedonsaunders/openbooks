import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { isFeatureEnabled } from '../../../lib/features'
import { createFieldTicket, FieldTicketError, TICKET_PERIODS, type TicketPeriod } from '../../../lib/field-tickets'

export const runtime = 'nodejs'

/** GET → ticket list (filters: status, project). POST → create a draft. */
export async function GET(req: Request) {
  const gate = await guardPermission('time.read')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const projectId = url.searchParams.get('project')
  const filters = sql.join(
    [
      status && ['draft', 'pending_approval', 'approved', 'voided'].includes(status) ? sql` and d.status = ${status}` : sql``,
      projectId && isUuid(projectId) ? sql` and d.project_id = ${projectId}` : sql``,
    ],
    sql``,
  )
  const rows = (await db.execute(sql`
    select d.id, d.document_number, d.status, d.document_date::text as document_date, d.total,
           d.custom->'fieldTicket'->>'period' as period,
           d.custom->'fieldTicket'->>'periodStart' as period_start,
           d.custom->'fieldTicket'->>'periodEnd' as period_end,
           (d.custom->'fieldTicket'->'signatures'->'customer'->>'at') as signed_at,
           (d.custom->'fieldTicket'->'send'->>'sentAt') as sent_at,
           cust.display_name as customer_name, p.name as project_name, p.code as project_code,
           fm.display_name as foreman_name,
           (select coalesce(sum(te.hours), 0) from time_entries te where te.field_ticket_id = d.id) as total_hours
      from documents d
      left join parties cust on cust.id = d.party_id
      left join projects p on p.id = d.project_id
      left join parties fm on fm.id = (d.custom->'fieldTicket'->>'foremanPartyId')::uuid
     where d.org_id = ${orgId} and d.kind = 'field_ticket'${filters}
     order by d.document_date desc, d.created_at desc
     limit 200`)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ tickets: rows.rows })
}

export async function POST(req: Request) {
  const gate = await guardPermission('time.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  if (!isUuid(body.projectId)) return NextResponse.json({ error: 'projectId required' }, { status: 422 })
  const period = TICKET_PERIODS.includes(body.period) ? (body.period as TicketPeriod) : undefined
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') ? body.date : undefined
  try {
    const created = await createFieldTicket(orgId, gate.user.id, { projectId: body.projectId, date, period })
    return NextResponse.json(created)
  } catch (e) {
    const status = e instanceof FieldTicketError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
