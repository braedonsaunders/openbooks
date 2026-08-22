import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { resolveInvoicingPreference } from './invoicing-preference.ts'
import { loadProjectType } from './project-type'
import { canonicalDecimal } from './exact-decimal'
import { isFeatureEnabled } from './features'

/** CRUD for project billing requests + milestone schedules. */

export interface BillingRequestInput {
  projectId: string
  invoiceType?: 'progress' | 'final'
  basis?: 'date_range' | 'draw_amount' | 'time_selection' | 'milestone' | 'field_ticket'
  drawAmount?: string | null
  startDate?: string | null
  cutoffDate?: string | null
  invoiceDescription?: string | null
  customerPo?: string | null
  backupRequired?: boolean
  backupType?: string
  selectedTimeEntryIds?: string[] | null
  fieldTicketIds?: string[] | null
  notes?: string | null
}

const BACKUP_TYPES = new Set([
  'none', 'costed_timesheets', 'quote_only', 'timesheets_purchases', 'purchases', 'purchases_shop_time',
])
const BASES = new Set(['date_range', 'draw_amount', 'time_selection', 'milestone', 'field_ticket'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function createBillingRequest(orgId: string, userId: string, input: BillingRequestInput) {
  if (!(await isFeatureEnabled(orgId, 'projects'))) throw new Error('Projects feature is disabled')
  const proj = (await db.execute<{ id: string; customer_po_number: string | null }>(sql`
    select id, customer_po_number from projects where id = ${input.projectId} and org_id = ${orgId}
  `))
  if (!proj.rows[0]) throw new Error('Project not found')

  // The project type is the authoritative classifier; snapshot its coarse
  // billing method onto the request so historical invoices stay reproducible.
  const projectType = await loadProjectType(orgId, input.projectId)

  // Defaults come from the resolved invoicing preference cascade
  // (project type ← customer ← project) unless the request overrides them.
  const eff = await resolveInvoicingPreference(orgId, input.projectId)
  if (eff.billingProcedure === 'application_for_payment') {
    throw new Error('This project bills through applications for payment; create the invoice from its Schedule of Values workflow')
  }
  if (input.invoiceType !== undefined && input.invoiceType !== 'progress' && input.invoiceType !== 'final') {
    throw new Error('Invoice stage must be progress or final')
  }
  const requestedBasis = input.basis ?? eff.defaultBasis
  if (!BASES.has(requestedBasis)) throw new Error('Choose a valid billing basis')
  if (!eff.allowedBases.includes(requestedBasis)) {
    throw new Error('The selected billing basis is not enabled for this project type')
  }
  if (requestedBasis === 'field_ticket' && !(await isFeatureEnabled(orgId, 'fieldTickets'))) {
    throw new Error('Field Ticket billing is disabled')
  }
  const basis = requestedBasis
  const fieldTicketIds = [...new Set((input.fieldTicketIds ?? []).map(String))].sort()
  if (basis === 'field_ticket') {
    if (fieldTicketIds.length === 0) throw new Error('Select at least one Field Ticket')
    if (fieldTicketIds.some((id) => !UUID.test(id))) throw new Error('A selected Field Ticket is invalid')
  } else if (fieldTicketIds.length > 0) {
    throw new Error('Field Tickets may be selected only for Field Ticket billing')
  }
  const backupRequired = input.backupRequired ?? eff.backupRequired
  const backupType = input.backupType && BACKUP_TYPES.has(input.backupType)
    ? input.backupType
    : backupRequired && BACKUP_TYPES.has(eff.backupType) ? eff.backupType : 'none'
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`billing-request-number:${orgId}`}, 0))
    `)
    const numberRow = (await tx.execute<{ n: string }>(sql`
      select coalesce(max((regexp_replace(request_number, '\\D', '', 'g'))::bigint), 0) as n
        from billing_requests
       where org_id = ${orgId}
         and request_number ~ '^BREQ-[0-9]+$'
    `))
    const requestNumber = `BREQ-${String(Number(numberRow.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`

    if (basis === 'field_ticket') {
      const selected = (await tx.execute<{ id: string }>(sql`
        select ticket.id
          from documents ticket
         where ticket.org_id = ${orgId}
           and ticket.project_id = ${input.projectId}
           and ticket.kind = 'field_ticket'
           and ticket.status = 'approved'
           and ticket.id = any(${`{${fieldTicketIds.join(',')}}`}::uuid[])
           and (
             exists (
               select 1
                 from time_entries entry
                where entry.org_id = ticket.org_id
                  and entry.field_ticket_id = ticket.id
                  and entry.status = 'approved'
                  and entry.is_billable
                  and entry.billing_status = 'unbilled'
             )
             or exists (
               select 1
                 from document_lines line
                 join documents source
                   on source.id = line.document_id
                  and source.org_id = line.org_id
                where line.org_id = ticket.org_id
                  and line.field_ticket_id = ticket.id
                  and line.is_billable
                  and line.billed_by_line_id is null
                  and source.kind <> 'field_ticket'
                  and source.status in ('approved', 'posted')
             )
           )
         order by ticket.id
         for update
      `))
      if (selected.rows.length !== fieldTicketIds.length) {
        throw new Error('Every selected Field Ticket must be approved, unbilled, and belong to this project')
      }
      const unavailable = (await tx.execute<{ document_number: string }>(sql`
        select ticket.document_number
          from billing_request_field_tickets selected
          join billing_requests request
            on request.id = selected.billing_request_id
           and request.org_id = selected.org_id
          join documents ticket
            on ticket.id = selected.field_ticket_id
           and ticket.org_id = selected.org_id
         where selected.org_id = ${orgId}
           and selected.field_ticket_id = any(${`{${fieldTicketIds.join(',')}}`}::uuid[])
           and request.status <> 'cancelled'
         order by ticket.document_number
      `))
      if (unavailable.rows.length > 0) {
        throw new Error(`Field Ticket ${unavailable.rows.map((row) => row.document_number).join(', ')} is already on another billing request`)
      }
    }

    let drawAmount: string | null = null
    if (input.drawAmount != null && input.drawAmount !== '') {
      const exact = canonicalDecimal(input.drawAmount, 4)
      if (exact === null) throw new Error('Draw amount must be an exact decimal')
      try {
        drawAmount = normalizeMoney(exact)
      } catch {
        throw new Error('Draw amount must be an exact decimal')
      }
    }

    const row = (await tx.execute<{ id: string; request_number: string }>(sql`
      insert into billing_requests (
        org_id, project_id, request_number, invoice_type, basis, draw_amount, start_date, cutoff_date,
        invoice_description, customer_po, billing_method_snapshot, backup_required, backup_type,
        selected_time_entry_ids, notes, status, created_by, updated_by)
      values (
        ${orgId}, ${input.projectId}, ${requestNumber}, ${input.invoiceType ?? 'progress'}, ${basis},
        ${drawAmount}, ${input.startDate ?? null}, ${input.cutoffDate ?? null},
        ${input.invoiceDescription ?? null}, ${input.customerPo ?? proj.rows[0].customer_po_number},
        ${projectType.billingMethod}, ${backupRequired}, ${backupType},
        ${input.selectedTimeEntryIds ? JSON.stringify(input.selectedTimeEntryIds) : null},
        ${input.notes ?? null}, 'open', ${userId}, ${userId})
      returning id, request_number
    `))
    const created = row.rows[0]!

    for (const fieldTicketId of fieldTicketIds) {
      await tx.execute(sql`
        insert into billing_request_field_tickets (
          org_id, billing_request_id, field_ticket_id, selected_by
        )
        values (${orgId}, ${created.id}, ${fieldTicketId}, ${userId})
      `)
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId},
        'billing_requests',
        ${created.id},
        'insert',
        ${JSON.stringify({
          after: {
            projectId: input.projectId,
            requestNumber,
            invoiceType: input.invoiceType ?? 'progress',
            basis,
            fieldTicketIds,
          },
        })}::jsonb,
        ${userId}
      )
    `)
    return created
  })
}

export type BillingRequestRow = {
  id: string
  requestNumber: string
  invoiceType: string
  basis: string
  drawAmount: string | null
  startDate: string | null
  cutoffDate: string | null
  backupRequired: boolean
  backupType: string
  status: string
  invoiceDocumentId: string | null
  invoiceNumber: string | null
  invoiceStatus: string | null
  invoiceTotal: string | null
  fieldTicketCount: number
  createdAt: string
};

export async function listBillingRequests(orgId: string, projectId: string): Promise<BillingRequestRow[]> {
  const r = (await db.execute<BillingRequestRow>(sql`
    select br.id, br.request_number as "requestNumber", br.invoice_type as "invoiceType",
           br.basis, br.draw_amount as "drawAmount", br.start_date as "startDate",
           br.cutoff_date as "cutoffDate", br.backup_required as "backupRequired",
           br.backup_type as "backupType", br.status, br.invoice_document_id as "invoiceDocumentId",
           d.document_number as "invoiceNumber", d.status as "invoiceStatus", d.total as "invoiceTotal",
           (select count(*)::int
              from billing_request_field_tickets selected
             where selected.org_id = br.org_id
               and selected.billing_request_id = br.id) as "fieldTicketCount",
           br.created_at as "createdAt"
      from billing_requests br
      left join documents d on d.id = br.invoice_document_id and d.org_id = br.org_id
     where br.org_id = ${orgId} and br.project_id = ${projectId}
     order by br.created_at desc
  `))
  return r.rows
}

export type BillableFieldTicketRow = {
  id: string
  documentNumber: string
  documentDate: string
  periodStart: string
  periodEnd: string
  customerSigned: boolean
  unbilledHours: string
};

export async function listBillableFieldTickets(
  orgId: string,
  projectId: string,
): Promise<BillableFieldTicketRow[]> {
  const rows = (await db.execute<BillableFieldTicketRow>(sql`
    select ticket.id,
           ticket.document_number as "documentNumber",
           ticket.document_date::text as "documentDate",
           field_ticket.period_start::text as "periodStart",
           field_ticket.period_end::text as "periodEnd",
           exists (
             select 1
               from field_ticket_signatures signature
              where signature.org_id = ticket.org_id
                and signature.field_ticket_id = ticket.id
                and signature.role = 'customer'
           ) as "customerSigned",
           coalesce((
             select sum(entry.hours)
               from time_entries entry
              where entry.org_id = ticket.org_id
                and entry.field_ticket_id = ticket.id
                and entry.status = 'approved'
                and entry.is_billable
                and entry.billing_status = 'unbilled'
           ), 0)::text as "unbilledHours"
      from documents ticket
      join field_tickets field_ticket
        on field_ticket.document_id = ticket.id
       and field_ticket.org_id = ticket.org_id
     where ticket.org_id = ${orgId}
       and ticket.project_id = ${projectId}
       and ticket.kind = 'field_ticket'
       and ticket.status = 'approved'
       and (
         exists (
           select 1
             from time_entries entry
            where entry.org_id = ticket.org_id
              and entry.field_ticket_id = ticket.id
              and entry.status = 'approved'
              and entry.is_billable
              and entry.billing_status = 'unbilled'
         )
         or exists (
           select 1
             from document_lines line
             join documents source
               on source.id = line.document_id
              and source.org_id = line.org_id
            where line.org_id = ticket.org_id
              and line.field_ticket_id = ticket.id
              and line.is_billable
              and line.billed_by_line_id is null
              and source.kind <> 'field_ticket'
              and source.status in ('approved', 'posted')
         )
       )
       and not exists (
         select 1
           from billing_request_field_tickets selected
           join billing_requests request
             on request.id = selected.billing_request_id
            and request.org_id = selected.org_id
          where selected.org_id = ticket.org_id
            and selected.field_ticket_id = ticket.id
            and request.status <> 'cancelled'
       )
     order by field_ticket.period_end desc, ticket.document_number desc
  `))
  return rows.rows
}

export async function cancelBillingRequest(orgId: string, userId: string, id: string) {
  return db.transaction(async (tx) => {
    const r = (await tx.execute<{ id: string }>(sql`
      update billing_requests
         set status = 'cancelled', updated_at = now(), updated_by = ${userId}
       where id = ${id} and org_id = ${orgId} and status = 'open'
       returning id
    `))
    if (!r.rows[0]) throw new Error('Only an open billing request can be cancelled')
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId},
        'billing_requests',
        ${id},
        'update',
        '{"before":{"status":"open"},"after":{"status":"cancelled"}}'::jsonb,
        ${userId}
      )
    `)
    return r.rows[0]
  })
}
