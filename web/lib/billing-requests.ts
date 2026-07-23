import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { resolveInvoicingPreference } from './invoicing-preference.ts'
import { isFeatureEnabled } from './features'

/** CRUD for project billing requests + milestone schedules. */

export interface BillingRequestInput {
  projectId: string
  invoiceType?: 'progress' | 'final'
  basis?: 'date_range' | 'draw_amount' | 'time_selection' | 'milestone'
  drawAmount?: string | null
  startDate?: string | null
  cutoffDate?: string | null
  invoiceDescription?: string | null
  customerPo?: string | null
  backupRequired?: boolean
  backupType?: string
  selectedTimeEntryIds?: string[] | null
  notes?: string | null
}

const BACKUP_TYPES = new Set([
  'none', 'costed_timesheets', 'quote_only', 'timesheets_purchases', 'purchases', 'purchases_shop_time',
])
const BASES = new Set(['date_range', 'draw_amount', 'time_selection', 'milestone'])

/** Next BREQ-##### number for an org (max existing suffix + 1). */
export async function nextBillingRequestNumber(orgId: string): Promise<string> {
  const r = (await db.execute(sql`
    select coalesce(max((regexp_replace(request_number, '\\D', '', 'g'))::bigint), 0) as n
      from billing_requests where org_id = ${orgId} and request_number ~ '^BREQ-[0-9]+$'
  `)) as unknown as { rows: { n: string }[] }
  const next = Number(r.rows[0]?.n ?? 0) + 1
  return `BREQ-${String(next).padStart(5, '0')}`
}

export async function createBillingRequest(orgId: string, userId: string, input: BillingRequestInput) {
  if (!(await isFeatureEnabled(orgId, 'projects'))) throw new Error('Projects feature is disabled')
  const proj = (await db.execute(sql`
    select id, billing_method, customer_po_number from projects where id = ${input.projectId} and org_id = ${orgId}
  `)) as unknown as { rows: { id: string; billing_method: string | null; customer_po_number: string | null }[] }
  if (!proj.rows[0]) throw new Error('Project not found')

  // Defaults come from the resolved invoicing preference cascade
  // (project type ← customer ← project) unless the request overrides them.
  const eff = await resolveInvoicingPreference(orgId, input.projectId)
  if (eff.billingProcedure === 'application_for_payment') {
    throw new Error('This project bills through applications for payment; create the invoice from its Schedule of Values workflow')
  }
  if (input.invoiceType !== undefined && input.invoiceType !== 'progress' && input.invoiceType !== 'final') {
    throw new Error('Invoice stage must be progress or final')
  }
  const basis = input.basis && BASES.has(input.basis) ? input.basis : (BASES.has(eff.defaultBasis) ? eff.defaultBasis : 'date_range')
  const backupRequired = input.backupRequired ?? eff.backupRequired
  const backupType = input.backupType && BACKUP_TYPES.has(input.backupType)
    ? input.backupType
    : backupRequired && BACKUP_TYPES.has(eff.backupType) ? eff.backupType : 'none'
  const requestNumber = await nextBillingRequestNumber(orgId)

  const row = (await db.execute(sql`
    insert into billing_requests (
      org_id, project_id, request_number, invoice_type, basis, draw_amount, start_date, cutoff_date,
      invoice_description, customer_po, billing_method_snapshot, backup_required, backup_type,
      selected_time_entry_ids, notes, status, created_by, updated_by)
    values (
      ${orgId}, ${input.projectId}, ${requestNumber}, ${input.invoiceType ?? 'progress'}, ${basis},
      ${input.drawAmount ?? null}, ${input.startDate ?? null}, ${input.cutoffDate ?? null},
      ${input.invoiceDescription ?? null}, ${input.customerPo ?? proj.rows[0].customer_po_number},
      ${proj.rows[0].billing_method}, ${backupRequired}, ${backupType},
      ${input.selectedTimeEntryIds ? JSON.stringify(input.selectedTimeEntryIds) : null},
      ${input.notes ?? null}, 'open', ${userId}, ${userId})
    returning id, request_number
  `)) as unknown as { rows: { id: string; request_number: string }[] }
  return row.rows[0]!
}

export interface BillingRequestRow {
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
  createdAt: string
}

export async function listBillingRequests(orgId: string, projectId: string): Promise<BillingRequestRow[]> {
  const r = (await db.execute(sql`
    select br.id, br.request_number as "requestNumber", br.invoice_type as "invoiceType",
           br.basis, br.draw_amount as "drawAmount", br.start_date as "startDate",
           br.cutoff_date as "cutoffDate", br.backup_required as "backupRequired",
           br.backup_type as "backupType", br.status, br.invoice_document_id as "invoiceDocumentId",
           d.document_number as "invoiceNumber", d.status as "invoiceStatus", d.total as "invoiceTotal",
           br.created_at as "createdAt"
      from billing_requests br
      left join documents d on d.id = br.invoice_document_id
     where br.org_id = ${orgId} and br.project_id = ${projectId}
     order by br.created_at desc
  `)) as unknown as { rows: BillingRequestRow[] }
  return r.rows
}

export async function cancelBillingRequest(orgId: string, userId: string, id: string) {
  const r = (await db.execute(sql`
    update billing_requests set status = 'cancelled', updated_by = ${userId}
     where id = ${id} and org_id = ${orgId} and status = 'open'
     returning id
  `)) as unknown as { rows: { id: string }[] }
  if (!r.rows[0]) throw new Error('Only an open billing request can be cancelled')
  return r.rows[0]
}
