import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { createFieldTicket, FieldTicketError, FieldTicketNotFoundError, TICKET_PERIODS, type TicketPeriod } from '../../../lib/field-tickets'
import { notFound, unprocessable } from "@/lib/api/responses";


export const runtime = 'nodejs'
const createBody = z.object({
  projectId: z.string().uuid().optional(),
  period: z.enum(TICKET_PERIODS).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()

/**
 * GET → ticket list (filters: status, project).
 * POST → create a draft from the unsaved New-ticket drawer's Save. The
 * caller's UUID Idempotency-Key becomes the ticket id, so a retried Save
 * returns the same ticket (200) instead of minting a second number (201).
 */
export const GET = defineRoute({
  permission: 'time.read',
  feature: 'fieldTickets',
  handler: async ({ request: req, authz: gate }) => {
  const orgId = gate.user.orgId

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const projectId = url.searchParams.get('project')
  // The caller's subsidiary visibility narrows the list exactly like every
  // other documents list (documentWhere): a restricted caller sees only their
  // subsidiaries, and an empty scope sees nothing. A null subsidiary fails
  // closed, mirroring the [id] route's record gate.
  const scope = gate.allowedSubsidiaryIds
  const filters = sql.join(
    [
      status && ['draft', 'pending_approval', 'approved', 'voided'].includes(status) ? sql` and d.status = ${status}` : sql``,
      projectId && isUuid(projectId) ? sql` and d.project_id = ${projectId}` : sql``,
      scope ? (scope.size ? sql` and d.subsidiary_id = any(${`{${[...scope].join(',')}}`}::uuid[])` : sql` and false`) : sql``,
    ],
    sql``,
  )
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select d.id, d.document_number, d.status, d.document_date::text as document_date, d.total,
           ft.period, ft.period_start::text as period_start,
           ft.period_end::text as period_end,
           (select max(signature.signed_at)
              from field_ticket_signatures signature
             where signature.org_id = d.org_id
               and signature.field_ticket_id = d.id
               and signature.role = 'customer') as signed_at,
           (select max(request.sent_at)
              from field_ticket_signature_requests request
             where request.org_id = d.org_id
               and request.field_ticket_id = d.id
               and request.sent_at is not null) as sent_at,
           cust.display_name as customer_name, p.name as project_name, p.code as project_code,
           fm.display_name as foreman_name,
           (select coalesce(sum(te.hours), 0) from time_entries te where te.field_ticket_id = d.id and te.org_id = d.org_id) as total_hours
      from documents d
      join field_tickets ft
        on ft.document_id = d.id and ft.org_id = d.org_id
      left join parties cust on cust.id = d.party_id and cust.org_id = d.org_id
      left join projects p on p.id = d.project_id and p.org_id = d.org_id
      left join parties fm on fm.id = ft.foreman_party_id and fm.org_id = ft.org_id
     where d.org_id = ${orgId} and d.kind = 'field_ticket'${filters}
     order by d.document_date desc, d.created_at desc
     limit 200`))
  return NextResponse.json({ tickets: rows.rows })
  },
})

export const POST = defineRoute({
  permission: 'time.manage',
  feature: 'fieldTickets',
  handler: async ({ request: req, authz: gate }) => {
  const orgId = gate.user.orgId

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return unprocessable('invalid_idempotency_key', { status: 400 })
  }
  const parsedBody = await parseJsonBody(req, createBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (typeof body.projectId === 'string') {
    // Creating under a project is itself a subsidiary boundary — the ticket
    // inherits the job's legal entity. A projectless draft has no subsidiary
    // yet and receives the same scope check when its project is selected.
    const scopedProject = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select p.subsidiary_id as "subsidiaryId"
        from projects p
       where p.id = ${body.projectId} and p.org_id = ${orgId} and p.is_active
    `))
    if (!scopedProject.rows[0]) return notFound("record")
    const projectDenied = guardSubsidiaryScope(
      gate.allowedSubsidiaryIds === undefined ? { ...gate, allowedSubsidiaryIds: null } : gate,
      scopedProject.rows[0].subsidiaryId,
    )
    if (projectDenied) return projectDenied
  }
  const period = body.period as TicketPeriod | undefined
  const date = body.date
  try {
    const created = await createFieldTicket(orgId, gate.user.id, { projectId: body.projectId, date, period, allowedSubsidiaryIds: gate.allowedSubsidiaryIds, requestId })
    return NextResponse.json({ id: created.id, documentNumber: created.documentNumber }, { status: created.created ? 201 : 200 })
  } catch (e) {
    if (e instanceof FieldTicketError && !(e instanceof FieldTicketNotFoundError)) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    return apiErrorResponse(e)
  }
  },
})
