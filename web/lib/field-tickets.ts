import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrg } from '@openbooks/engine/src/db.ts'
import { submitForApproval } from '@openbooks/engine/src/flows/index.ts'
import {
  captureFieldTicketLaborEvidence,
  type FieldTicketLaborEvidenceLine,
} from '@openbooks/engine/src/field-ticket-labor-evidence.ts'
import { mul, div, isZero, add, sum } from '@openbooks/engine/src/money.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { nextDocumentNumber } from './bills'
import { createProjectCharge } from './project-charges'
import { resolveItemRate, snapshotTimeBillRates } from './item-rates'
import { getS3Blob } from './file-storage'

/**
 * Field tickets — the signed crew timesheet for T&M work (the industry's
 * LEM sheet / field ticket / billable timesheet), native as a NON-POSTING
 * `documents` kind:
 *
 *   header    documents (kind 'field_ticket') + the one-to-one field_tickets
 *             native extension; customer = party_id, job = project_id
 *   hours     time_entries rows (field_ticket_id); each atomic line belongs to
 *             one project and zero-or-one ticket, while its timesheet/payroll
 *             approval lifecycle remains independent. Approval captures a
 *             versioned commercial labor snapshot; it never turns that
 *             snapshot into a second time/payroll ledger.
 *   items     document_lines on the ticket; approval materializes them as a
 *             posted project_charge so the T&M billing engine sweeps them
 *   signing   foreman + customer signatures stored on the ticket; the signed
 *             PDF becomes invoice backup
 *
 * Ticket period is shift / daily / weekly, resolved job > customer > org.
 */

export type TicketPeriod = 'shift' | 'daily' | 'weekly'
export const TICKET_PERIODS: TicketPeriod[] = ['shift', 'daily', 'weekly']

export interface TicketSignature {
  image: string | null // data-URL PNG from the signature pad
  name: string
  comment?: string | null
  at: string // ISO timestamp
}

/** Native Field Ticket payload exposed to UI/PDF callers. This is assembled
 * from relational tables; it is not persisted in documents.custom. */
export interface FieldTicketData {
  period: TicketPeriod
  periodStart: string
  periodEnd: string
  foremanPartyId: string | null
  signatures?: { foreman?: TicketSignature; customer?: TicketSignature }
  send?: { to?: string | null; sentAt: string; expiresAt: string; message?: string | null; respondedAt?: string | null }
  rejectionReason?: string | null
  /** The project_charge materialized at approval (item lines → job cost + billing). */
  chargeDocumentId?: string | null
}

export class FieldTicketError extends Error {}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Sunday-start week window (matches timesheets), or the single day. */
export function ticketWindow(period: TicketPeriod, anchorIso: string): { start: string; end: string } {
  const [y, m, d] = anchorIso.split('-').map(Number)
  if (period !== 'weekly') return { start: anchorIso, end: anchorIso }
  const date = new Date(Date.UTC(y, m - 1, d, 12))
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  const start = iso(date)
  date.setUTCDate(date.getUTCDate() + 6)
  return { start, end: iso(date) }
}

/** Resolve the effective-dated policy: project > customer > organization >
 * product default. The chosen value is snapshotted on the ticket header. */
export async function resolveTicketPeriod(
  orgId: string,
  projectId: string | null,
  onDate?: string,
): Promise<TicketPeriod> {
  const asOf = onDate ?? await businessToday(orgId)
  const valid = (v: unknown): v is TicketPeriod => TICKET_PERIODS.includes(v as TicketPeriod)
  const resolved = (await db.execute<{ period: string }>(sql`
    select policy.period
      from field_ticket_policies policy
      left join projects project
        on project.id = ${projectId} and project.org_id = policy.org_id
     where policy.org_id = ${orgId}
       and policy.is_active
       and policy.effective_from <= ${asOf}::date
       and (policy.effective_to is null or policy.effective_to >= ${asOf}::date)
       and (
         (policy.scope = 'project' and policy.project_id = ${projectId})
         or (policy.scope = 'customer' and policy.customer_party_id = project.customer_id)
         or policy.scope = 'organization'
       )
     order by case policy.scope
       when 'project' then 1 when 'customer' then 2 else 3 end,
       policy.effective_from desc
     limit 1
  `))
  return valid(resolved.rows[0]?.period) ? resolved.rows[0].period : 'weekly'
}

/**
 * Create a draft ticket instantly (no inputs needed — the standard flyout form
 * picks the project, which then derives customer/PO/period). PO lives in
 * documents.reference_number and the work description in documents.memo, so
 * the ordinary configurable header form covers them.
 */
export async function createFieldTicket(
  orgId: string,
  userId: string,
  input: { projectId?: string | null; date?: string; period?: TicketPeriod } = {},
): Promise<{ id: string; documentNumber: string }> {
  const proj = input.projectId
    ? (
        (await db.execute<{ id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null }>(sql`
          select p.id, p.customer_id, p.subsidiary_id, p.custom->>'poNumber' as po
            from projects p where p.id = ${input.projectId} and p.org_id = ${orgId}`))
      ).rows[0] ?? null
    : null
  if (input.projectId && !proj) throw new FieldTicketError('Project not found')
  const anchorDate = input.date ?? await businessToday(orgId)
  const period = input.period ?? (await resolveTicketPeriod(orgId, input.projectId ?? null, anchorDate))
  const window = ticketWindow(period, anchorDate)
  const org = (await db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${orgId}`))
  const foreman = (await db.execute<{ party_id: string | null }>(sql`select party_id from users where id = ${userId}`))
  const documentNumber = await nextDocumentNumber(orgId, 'field_ticket', 'FT-', proj?.subsidiary_id ?? undefined)
  return withOrg(orgId, async () => {
    const row = (await db.execute<{ id: string; document_number: string }>(sql`
      insert into documents (org_id, kind, document_number, document_date, currency, status, party_id, project_id,
                             subsidiary_id, reference_number, billing_method, subtotal, tax_total, total, custom, created_by)
      values (${orgId}, 'field_ticket', ${documentNumber}, ${window.end}, ${org.rows[0]?.base_currency ?? 'CAD'},
              'draft', ${proj?.customer_id ?? null}, ${proj?.id ?? null}, ${proj?.subsidiary_id ?? null},
              ${proj?.po ?? null}, 'time_and_materials', '0', '0', '0', '{}'::jsonb, ${userId})
      returning id, document_number`))
    await db.execute(sql`
      insert into field_tickets
        (document_id, org_id, period, period_start, period_end, foreman_party_id,
         created_by, updated_by)
      values (${row.rows[0].id}, ${orgId}, ${period}, ${window.start}, ${window.end},
              ${foreman.rows[0]?.party_id ?? null}, ${userId}, ${userId})
    `)
    return { id: row.rows[0].id, documentNumber: row.rows[0].document_number }
  })
}

/**
 * Header updates from the standard flyout form. Changing the project
 * re-derives customer/subsidiary/PO and (unless hours exist) the period
 * window; changing the period or anchor date re-windows a still-empty ticket.
 */
export async function updateTicketHeader(
  orgId: string,
  userId: string,
  ticketId: string,
  patch: {
    projectId?: string | null
    documentDate?: string
    referenceNumber?: string | null
    memo?: string | null
    period?: TicketPeriod
    foremanPartyId?: string | null
  },
): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
  const ft = { ...doc.fieldTicket }

  // Resolve every column ONCE in JS (a column may only be assigned once).
  let projChange: { id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null } | null = null
  if (patch.projectId !== undefined && patch.projectId !== doc.project_id) {
    if (!patch.projectId) throw new FieldTicketError('A ticket needs a project')
    const proj = (await db.execute<{ id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null }>(sql`
      select p.id, p.customer_id, p.subsidiary_id, p.custom->>'poNumber' as po
        from projects p where p.id = ${patch.projectId} and p.org_id = ${orgId}`))
    if (!proj.rows[0]) throw new FieldTicketError('Project not found')
    projChange = proj.rows[0]
    // Re-resolve the period for the new job unless the caller pinned one.
    if (patch.period === undefined) {
      const resolved = await resolveTicketPeriod(orgId, projChange.id, patch.documentDate ?? doc.document_date)
      if (resolved !== ft.period) patch.period = resolved
    }
  }

  const hourCount = (
    (await db.execute<{ n: number }>(sql`select count(*)::int as n from time_entries where org_id = ${orgId} and field_ticket_id = ${ticketId}`))
  ).rows[0].n
  if ((patch.period !== undefined || patch.documentDate !== undefined) && hourCount === 0) {
    const period = patch.period ?? ft.period
    const anchor = patch.documentDate ?? doc.document_date
    const window = ticketWindow(period, anchor)
    ft.period = period
    ft.periodStart = window.start
    ft.periodEnd = window.end
  }
  if (patch.foremanPartyId !== undefined) ft.foremanPartyId = patch.foremanPartyId

  const nextRef =
    patch.referenceNumber !== undefined
      ? patch.referenceNumber
      : projChange && !doc.reference_number
        ? projChange.po
        : doc.reference_number
  const nextMemo = patch.memo !== undefined ? patch.memo : doc.memo
  const nextDate = patch.documentDate ?? doc.document_date

  await db.execute(sql`
    update documents set
      project_id = ${projChange ? projChange.id : doc.project_id},
      party_id = ${projChange ? projChange.customer_id : sql`party_id`},
      subsidiary_id = ${projChange ? projChange.subsidiary_id : sql`subsidiary_id`},
      document_date = ${nextDate},
      reference_number = ${nextRef},
      memo = ${nextMemo},
      updated_at = now(), updated_by = ${userId}
     where id = ${ticketId} and org_id = ${orgId}`)
  await db.execute(sql`
    update field_tickets
       set period = ${ft.period}, period_start = ${ft.periodStart},
           period_end = ${ft.periodEnd}, foreman_party_id = ${ft.foremanPartyId},
           updated_at = now(), updated_by = ${userId}
     where document_id = ${ticketId} and org_id = ${orgId}
  `)
  // Re-home any existing draft hours/lines onto the new project.
  if (projChange) {
    await db.execute(sql`update time_entries set project_id = ${projChange.id}, project_task_id = null where field_ticket_id = ${ticketId} and org_id = ${orgId} and status = 'draft'`)
    await db.execute(sql`update document_lines set project_id = ${projChange.id} where document_id = ${ticketId} and org_id = ${orgId}`)
  }
}

export interface CrewRowInput {
  employeePartyId: string
  /** Billable labor/service item shown on the ticket (optional). */
  itemId: string | null
  projectTaskId?: string | null
  timeTypeId: string
  /** hours keyed by ISO date within the ticket window ('' / 0 = none). */
  hours: Record<string, number>
}

/**
 * Sync the crew grid onto time_entries: one row per employee × item × time
 * type × day. Upserts changed hours, deletes cleared cells. Draft tickets only.
 */
export async function saveCrewGrid(orgId: string, userId: string, ticketId: string, rows: CrewRowInput[]): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
  const ft = doc.fieldTicket

  const existing = (await db.execute<{ id: string; employee_party_id: string; item_id: string | null; project_task_id: string | null; time_type_id: string; worked_on: string; hours: string }>(sql`
    select id, employee_party_id, item_id, project_task_id, time_type_id, worked_on::text as worked_on, hours
      from time_entries where org_id = ${orgId} and field_ticket_id = ${ticketId}`))
  const key = (e: { employee_party_id: string; item_id: string | null; project_task_id: string | null; time_type_id: string; worked_on: string }) =>
    `${e.employee_party_id}|${e.item_id ?? ''}|${e.project_task_id ?? ''}|${e.time_type_id}|${e.worked_on}`
  const byKey = new Map(existing.rows.map((e) => [key(e), e]))
  const seen = new Set<string>()

  // The field-ticket switch is independent of whether a type is usable in
  // ordinary timesheets. Existing ticket types remain legal so changing setup
  // never makes an older draft impossible to save.
  const requestedTypeIds = [...new Set(rows.map((row) => row.timeTypeId).filter(Boolean))]
  if (requestedTypeIds.length) {
    if (requestedTypeIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw new FieldTicketError('Choose a valid time type')
    }
    const existingTypeIds = new Set(existing.rows.map((entry) => entry.time_type_id))
    const selectable = (await db.execute<{ id: string }>(sql`
      select id from time_types
       where org_id = ${orgId} and is_active and show_on_field_ticket
         and id = any(${`{${requestedTypeIds.join(',')}}`}::uuid[])`))
    const allowed = new Set([...existingTypeIds, ...selectable.rows.map((type) => type.id)])
    if (requestedTypeIds.some((id) => !allowed.has(id))) {
      throw new FieldTicketError('Choose a time type enabled for field tickets')
    }
  }
  const requestedTaskIds = [...new Set(rows.map((row) => row.projectTaskId).filter((id): id is string => Boolean(id)))]
  if (requestedTaskIds.length) {
    if (requestedTaskIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw new FieldTicketError('Choose a valid project task')
    }
    const validTasks = (await db.execute<{ id: string }>(sql`
      select id from project_tasks where org_id = ${orgId} and project_id = ${doc.project_id}
        and id = any(${`{${requestedTaskIds.join(',')}}`}::uuid[])`))
    if (validTasks.rows.length !== requestedTaskIds.length) throw new FieldTicketError('Choose a task from this project')
  }

  for (const row of rows) {
    for (const [day, hours] of Object.entries(row.hours)) {
      if (day < ft.periodStart || day > ft.periodEnd) continue
      const k = `${row.employeePartyId}|${row.itemId ?? ''}|${row.projectTaskId ?? ''}|${row.timeTypeId}|${day}`
      const h = Number(hours)
      if (!Number.isFinite(h) || h <= 0) continue
      seen.add(k)
      const cur = byKey.get(k)
      if (cur) {
        if (Number(cur.hours) !== h) {
          await db.execute(sql`
            update time_entries set hours = ${h}, updated_at = now(), updated_by = ${userId}
             where id = ${cur.id} and org_id = ${orgId} and status = 'draft'`)
        }
      } else {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, time_type_id, item_id,
                                    project_id, project_task_id, is_billable, status, field_ticket_id, created_by, updated_by)
          values (${orgId}, ${row.employeePartyId}, ${day}, ${h}, ${row.timeTypeId}, ${row.itemId},
                  ${doc.project_id}, ${row.projectTaskId ?? null}, true, 'draft', ${ticketId}, ${userId}, ${userId})`)
      }
    }
  }
  // Remove cleared cells (draft entries only — approved history is immutable).
  for (const e of existing.rows) {
    if (!seen.has(key(e))) {
      await db.execute(sql`
        delete from time_entries where id = ${e.id} and org_id = ${orgId} and status = 'draft' and field_ticket_id = ${ticketId}`)
    }
  }
}

/** Add an item/equipment line using the same project/customer/unit rate-book
 * assignment and package-tier engine as project charges. */
export async function addTicketLine(
  orgId: string,
  userId: string,
  ticketId: string,
  input: {
    itemId: string; quantity: number; rateUnitCode?: string | null; equipmentUnitId?: string | null
    /** The crew member who ran this unit. See ChargeLineInput.employeeId — the
     * ticket is where somebody actually knows, because they are standing in
     * front of the machine while they fill it in. */
    employeeId?: string | null
    description?: string | null
  },
): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
  const item = (await db.execute<{ id: string; name: string; unit: string | null; default_rate: string | null; default_cost: string | null }>(sql`
    select id, name, unit, default_rate, default_cost from items where id = ${input.itemId} and org_id = ${orgId}`))
  if (!item.rows[0]) throw new FieldTicketError('Item not found')
  const qty = Number(input.quantity)
  if (!Number.isInteger(qty) || qty <= 0) throw new FieldTicketError('Quantity must be a positive whole number')

  if (!doc.project_id) throw new FieldTicketError('Choose a project before adding items')
  if (input.equipmentUnitId) {
    const equipment = (await db.execute<{ charge_item_id: string | null; status: string }>(sql`
      select charge_item_id, status from equipment_units
       where id = ${input.equipmentUnitId} and org_id = ${orgId}`))
    if (!equipment.rows[0] || equipment.rows[0].status !== 'active' || equipment.rows[0].charge_item_id !== input.itemId) {
      throw new FieldTicketError('Choose active equipment linked to this item')
    }
  }
  if (input.employeeId) {
    if (!input.equipmentUnitId) {
      throw new FieldTicketError('Only an equipment line can record an operator')
    }
    // The operator must be on THIS ticket's crew. A ticket is signed as a
    // record of who was on site that day, so attributing equipment to someone
    // the ticket does not place there would make the signature cover a claim it
    // never made — and this line becomes payable money downstream.
    const crew = (await db.execute(sql`
      select 1 from time_entries
       where org_id = ${orgId} and field_ticket_id = ${ticketId}
         and employee_party_id = ${input.employeeId}
       limit 1`))
    if (!crew.rows[0]) throw new FieldTicketError('The operator must be on this ticket’s crew')
  }

  const quantity = String(qty)
  let resolved: Awaited<ReturnType<typeof resolveItemRate>>
  try {
    resolved = await resolveItemRate({
      orgId,
      projectId: doc.project_id,
      itemId: input.itemId,
      equipmentUnitId: input.equipmentUnitId,
      onDate: doc.fieldTicket.periodEnd,
      baseQuantity: quantity,
      rateUnitCode: input.rateUnitCode,
    })
  } catch (error) {
    throw new FieldTicketError(error instanceof Error ? error.message : 'Could not resolve item rate')
  }
  const costAmount = resolved?.cost.amount ?? mul(quantity, String(item.rows[0].default_cost ?? '0'))
  const billAmount = resolved?.bill.amount ?? mul(quantity, String(item.rows[0].default_rate ?? item.rows[0].default_cost ?? '0'))
  // A zero-quantity ticket line has no unit rate to derive; dividing by it
  // raised an FX-rate error for what is really an empty quantity.
  const costRate = isZero(quantity) ? '0.0000' : div(costAmount, quantity)
  const billRate = isZero(quantity) ? '0.0000' : div(billAmount, quantity)
  const baseUnit = resolved?.baseUnit ?? item.rows[0].unit ?? 'unit'
  const baseQuantity = resolved?.baseQuantity ?? quantity
  const transactionUnit = resolved?.transactionUnitCode ?? item.rows[0].unit ?? 'unit'

  const next = (await db.execute<{ n: number }>(sql`
    select coalesce(max(line_number), 0) + 1 as n from document_lines where document_id = ${ticketId} and org_id = ${orgId}`))
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into document_lines (org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount,
                                project_id, is_billable, equipment_unit_id, employee_id, rate_version_id, rate_presentation,
                                base_quantity, base_unit, cost_rate, bill_rate, cost_amount, bill_amount,
                                field_ticket_id, created_by, updated_by)
    values (${orgId}, ${ticketId}, ${next.rows[0].n}, ${input.itemId}, ${input.description ?? item.rows[0].name},
            ${quantity}, ${transactionUnit}, ${billRate}, ${billAmount}, ${doc.project_id}, true, ${input.equipmentUnitId ?? null},
            ${input.employeeId ?? null},
            ${resolved?.rateVersionId ?? null}, ${resolved?.invoicePresentation ?? 'summary'}, ${baseQuantity}, ${baseUnit},
            ${costRate}, ${billRate}, ${costAmount}, ${billAmount}, ${ticketId}, ${userId}, ${userId}) returning id`))
  const components = [
    ...(resolved?.cost.components ?? [{ rateLineId: null, unitCode: baseUnit, unitName: baseUnit, quantity, rate: costRate, amount: costAmount }]).map((c) => ({ ...c, role: 'cost' })),
    ...(resolved?.bill.components ?? [{ rateLineId: null, unitCode: baseUnit, unitName: baseUnit, quantity, rate: billRate, amount: billAmount }]).map((c) => ({ ...c, role: 'bill' })),
  ]
  let sequence = 1
  for (const component of components) {
    await db.execute(sql`
      insert into charge_rate_components (org_id, document_line_id, role, rate_line_id, unit_code, unit_name,
                                           quantity, rate, amount, sequence, created_by, updated_by)
      values (${orgId}, ${inserted.rows[0].id}, ${component.role}, ${component.rateLineId}, ${component.unitCode},
              ${component.unitName}, ${component.quantity}, ${component.rate}, ${component.amount}, ${sequence++},
              ${userId}, ${userId})`)
  }
  await recomputeTotals(orgId, ticketId)
}

export async function removeTicketLine(orgId: string, ticketId: string, lineId: string): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
  await db.execute(sql`delete from charge_rate_components where document_line_id = ${lineId} and org_id = ${orgId}`)
  await db.execute(sql`delete from document_lines where id = ${lineId} and document_id = ${ticketId} and org_id = ${orgId}`)
  await recomputeTotals(orgId, ticketId)
}

/** Ticket totals: labor (Σ hours × resolved bill rate at display time) is
 * computed by the loader; the DOCUMENT total carries the item lines. */
async function recomputeTotals(orgId: string, ticketId: string): Promise<void> {
  await db.execute(sql`
    update documents d set subtotal = x.amt, total = x.amt, updated_at = now()
      from (select coalesce(sum(amount), 0) as amt from document_lines where document_id = ${ticketId} and org_id = ${orgId}) x
     where d.id = ${ticketId} and d.org_id = ${orgId}`)
}
type HeaderRow = {
  id: string
  document_number: string
  status: string
  party_id: string | null
  project_id: string | null
  document_date: string
  currency: string
  reference_number: string | null
  memo: string | null
  period: TicketPeriod
  period_start: string
  period_end: string
  foreman_party_id: string | null
  charge_document_id: string | null
  submitted_by: string | null
  submitted_at: string | null
  rejection_reason: string | null
  fieldTicket: FieldTicketData
};

async function loadHeader(
  orgId: string,
  ticketId: string,
  lockForUpdate = false,
): Promise<HeaderRow> {
  const r = (await db.execute<HeaderRow>(sql`
    select d.id, d.document_number, d.status, d.party_id, d.project_id, d.currency,
           d.document_date::text as document_date, d.reference_number, d.memo,
           ft.period, ft.period_start::text as period_start,
           ft.period_end::text as period_end,
           ft.foreman_party_id, ft.charge_document_id, ft.submitted_by,
           ft.submitted_at::text as submitted_at, ft.rejection_reason
      from documents d
      join field_tickets ft
        on ft.document_id = d.id and ft.org_id = d.org_id
     where d.id = ${ticketId} and d.org_id = ${orgId}
       and d.kind = 'field_ticket'
     ${lockForUpdate ? sql`for update of d, ft` : sql``}`))
  if (!r.rows[0]) throw new FieldTicketError('Ticket not found')
  const row = r.rows[0]
  row.fieldTicket = {
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    foremanPartyId: row.foreman_party_id,
    chargeDocumentId: row.charge_document_id,
  }
  if (row.rejection_reason) {
    ;(row.fieldTicket as FieldTicketData & { rejectionReason?: string }).rejectionReason = row.rejection_reason
  }
  return row
}

interface LaborSnapshotResult {
  id: string
  revision: number
  lineCount: number
}

/**
 * Capture exactly what commercial approval releases. The snapshot is
 * idempotent for an already-current revision and is deliberately independent
 * from time-entry approval, labor posting, and payroll status.
 */
async function ensureFieldTicketLaborSnapshot(
  orgId: string,
  userId: string,
  doc: HeaderRow,
): Promise<LaborSnapshotResult> {
  const current = (await db.execute<{ id: string; revision: number; line_count: number }>(sql`
    select snapshot.id, snapshot.revision,
           (select count(*)::int
              from field_ticket_labor_lines line
             where line.org_id = snapshot.org_id
               and line.snapshot_id = snapshot.id) as line_count
      from field_ticket_labor_snapshots snapshot
     where snapshot.org_id = ${orgId}
       and snapshot.field_ticket_id = ${doc.id}
       and snapshot.superseded_at is null
     limit 1
  `))
  if (current.rows[0]) {
    return {
      id: current.rows[0].id,
      revision: Number(current.rows[0].revision),
      lineCount: Number(current.rows[0].line_count),
    }
  }

  const entries = (await db.execute<{
      id: string
      employee_party_id: string
      employee_name: string
      item_id: string | null
      item_name: string | null
      time_type_id: string | null
      time_type_name: string
      time_classification: 'regular' | 'overtime' | 'double_time' | 'other'
      project_task_id: string | null
      project_task_name: string | null
      worked_on: string
      hours: string
      status: string
      cost_rate: string | null
      cost_rate_currency: string | null
      bill_rate: string | null
      bill_rate_currency: string | null
    }>(sql`
    select te.id, te.employee_party_id, employee.display_name as employee_name,
           te.item_id, item.name as item_name,
           te.time_type_id, coalesce(time_type.name, 'Unclassified') as time_type_name,
           coalesce(time_type.classification, 'regular') as time_classification,
           te.project_task_id, project_task.name as project_task_name,
           te.worked_on::text as worked_on, te.hours, te.status,
           te.cost_rate, te.cost_rate_currency,
           te.bill_rate, te.bill_rate_currency
      from time_entries te
      join parties employee
        on employee.id = te.employee_party_id
       and employee.org_id = te.org_id
      left join items item
        on item.id = te.item_id
       and item.org_id = te.org_id
      left join time_types time_type
        on time_type.id = te.time_type_id
       and time_type.org_id = te.org_id
      left join project_tasks project_task
        on project_task.id = te.project_task_id
       and project_task.org_id = te.org_id
     where te.org_id = ${orgId}
       and te.field_ticket_id = ${doc.id}
       and te.hours <> 0
     order by te.worked_on, te.employee_party_id, te.item_id nulls first,
              te.time_type_id nulls first, te.project_task_id nulls first, te.id
  `))
  const missingTimeType = entries.rows.find((entry) => !entry.time_type_id)
  if (missingTimeType) {
    throw new FieldTicketError(
      `Labor entry ${missingTimeType.id} needs a time type before this ticket can be approved`,
    )
  }

  const unresolvedBillRates = entries.rows
    .filter((entry) => entry.bill_rate == null)
    .map((entry) => entry.id)
  const resolvedBillRates = unresolvedBillRates.length
    ? await snapshotTimeBillRates(orgId, unresolvedBillRates, { dryRun: true })
    : new Map<string, string>()

  const lines: FieldTicketLaborEvidenceLine[] = []
  for (const entry of entries.rows) {
    const billRate = entry.bill_rate ?? resolvedBillRates.get(entry.id) ?? null
    const costAmount = entry.cost_rate == null
      ? null
      : mul(String(entry.hours), String(entry.cost_rate))
    const billAmount = billRate == null
      ? null
      : mul(String(entry.hours), String(billRate))
    lines.push({
      employeePartyId: entry.employee_party_id,
      employeeName: entry.employee_name,
      itemId: entry.item_id,
      itemName: entry.item_name,
      timeTypeId: entry.time_type_id,
      timeTypeName: entry.time_type_name,
      timeClassification: entry.time_classification,
      projectTaskId: entry.project_task_id,
      projectTaskName: entry.project_task_name,
      workedOn: entry.worked_on,
      hours: String(entry.hours),
      timeEntryId: entry.id,
      timeEntryStatus: entry.status,
      costRate: entry.cost_rate,
      costRateCurrency: entry.cost_rate_currency,
      billRate,
      billRateCurrency: entry.bill_rate_currency ?? doc.currency,
      costAmount,
      billAmount,
      sourceSystem: 'openbooks',
      sourceLineRef: entry.id,
    })
  }
  const snapshot = await captureFieldTicketLaborEvidence({
    orgId,
    fieldTicketId: doc.id,
    actorId: userId,
    evidenceBasis: 'operational_time',
    reason: 'Commercial labor evidence captured at Field Ticket approval',
    sourceSystem: 'openbooks',
    currency: doc.currency,
    lines,
  })
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    lineCount: snapshot.lineCount,
  }
}

async function auditTicketLifecycle(
  orgId: string,
  ticketId: string,
  actorId: string,
  action: 'update' | 'approve' | 'reject',
  changes: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${ticketId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
  `)
}

/**
 * Submit through Flows. An enabled tenant-authored on_submit flow may create
 * gates; when none does, the ticket approves immediately. There is no default
 * approver, hardcoded threshold, or parallel approval path.
 */
export async function submitFieldTicket(orgId: string, userId: string, ticketId: string): Promise<void> {
  const outcome = await withOrg(orgId, async () => {
    const doc = await loadHeader(orgId, ticketId)
    if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be submitted')
    const counts = (await db.execute<{ hours: number; lines: number }>(sql`
      select (select count(*) from time_entries where org_id = ${orgId} and field_ticket_id = ${ticketId}) as hours,
             (select count(*) from document_lines where org_id = ${orgId} and document_id = ${ticketId}) as lines`))
    if (Number(counts.rows[0].hours) === 0 && Number(counts.rows[0].lines) === 0) {
      throw new FieldTicketError('Add hours or lines before submitting')
    }

    await db.execute(sql`
      update field_tickets
         set submitted_by = ${userId}, submitted_at = now(),
             rejection_reason = null, updated_at = now(), updated_by = ${userId}
       where document_id = ${ticketId} and org_id = ${orgId}`)

    const routed = await submitForApproval('field_ticket', ticketId, userId)
    if (routed.flowError) {
      await auditTicketLifecycle(orgId, ticketId, userId, 'update', {
        source: 'flows',
        event: 'submit_failed',
        reason: routed.flowError,
      })
      return { flowError: routed.flowError }
    }

    if (routed.gated) {
      await auditTicketLifecycle(orgId, ticketId, userId, 'update', {
        source: 'flows',
        from: 'draft',
        to: 'pending_approval',
        flowRunId: routed.runId,
      })
      return { flowError: null }
    }

    await releaseFieldTicketApproval(orgId, userId, ticketId, 'approved', null)
    return { flowError: null }
  })
  if (outcome.flowError) throw new FieldTicketError(outcome.flowError)
}

/**
 * Deterministic approval release called by Flows, or directly after submit
 * when no tenant-authored approval gate exists. The caller owns a withOrg
 * transaction, so project-charge materialization, status, links, and audit
 * either all commit or all roll back. The ticket's commercial approval never
 * changes its atomic time lines' independent timesheet/payroll approval state.
 */
export async function releaseFieldTicketApproval(
  orgId: string,
  userId: string,
  ticketId: string,
  outcome: 'approved' | 'rejected',
  comment?: string | null,
): Promise<void> {
  const doc = await loadHeader(orgId, ticketId, true)
  if (outcome === 'rejected') {
    if (doc.status !== 'pending_approval') {
      throw new FieldTicketError('Only submitted tickets can be rejected')
    }
    const reason = comment?.trim() || 'Rejected in approval flow'
    await db.execute(sql`
      update documents set status = 'draft', updated_at = now(), updated_by = ${userId}
       where id = ${ticketId} and org_id = ${orgId}`)
    await db.execute(sql`
      update field_tickets
         set rejection_reason = ${reason.slice(0, 500)}, updated_at = now(),
             updated_by = ${userId}
       where document_id = ${ticketId} and org_id = ${orgId}`)
    await auditTicketLifecycle(orgId, ticketId, userId, 'reject', {
      source: 'flows',
      from: 'pending_approval',
      to: 'draft',
      reason,
    })
    return
  }

  if (doc.status !== 'draft' && doc.status !== 'pending_approval') {
    if (doc.status === 'approved') return
    throw new FieldTicketError('Only draft or submitted tickets can be approved')
  }
  const previousStatus = doc.status
  const laborSnapshot = await ensureFieldTicketLaborSnapshot(orgId, userId, doc)

  // Materialize item lines as a project charge so job cost + T&M billing see them.
  const lines = (await db.execute<{ id: string; item_id: string; description: string | null; quantity: string; unit: string | null; cost_rate: string | null;
      bill_rate: string | null; cost_amount: string | null; bill_amount: string | null; equipment_unit_id: string | null;
      employee_id: string | null;
      rate_version_id: string | null; rate_presentation: 'summary' | 'rate_components' | null;
      base_quantity: string | null; base_unit: string | null }>(sql`
    select id, item_id, description, quantity, unit, cost_rate, bill_rate, cost_amount, bill_amount,
           equipment_unit_id, employee_id, rate_version_id, rate_presentation, base_quantity, base_unit
      from document_lines
     where document_id = ${ticketId} and org_id = ${orgId} and item_id is not null`))
  let chargeDocumentId = doc.fieldTicket.chargeDocumentId ?? null
  if (lines.rows.length > 0 && doc.project_id && !chargeDocumentId) {
    const lineIds = `{${lines.rows.map((line) => line.id).join(',')}}`
    const componentRows = (await db.execute<{ document_line_id: string; role: 'cost' | 'bill'; rate_line_id: string | null; unit_code: string;
        unit_name: string; quantity: string; rate: string; amount: string }>(sql`
      select document_line_id, role, rate_line_id, unit_code, unit_name, quantity, rate, amount
        from charge_rate_components
       where org_id = ${orgId} and document_line_id = any(${lineIds}::uuid[])
       order by document_line_id, role, sequence`))
    const componentsFor = (lineId: string, role: 'cost' | 'bill') => componentRows.rows
      .filter((component) => component.document_line_id === lineId && component.role === role)
      .map((component) => ({ rateLineId: component.rate_line_id, unitCode: component.unit_code,
        unitName: component.unit_name, quantity: component.quantity, rate: component.rate, amount: component.amount }))
    const charge = await createProjectCharge(
      orgId,
      userId,
      {
        projectId: doc.project_id,
        fieldTicketId: ticketId,
        referenceNumber: doc.document_number,
        documentDate: doc.fieldTicket.periodEnd,
        lines: lines.rows.map((l) => {
          const costComponents = componentsFor(l.id, 'cost')
          const billComponents = componentsFor(l.id, 'bill')
          const hasSnapshot = costComponents.length > 0 && billComponents.length > 0
          return {
            itemId: l.item_id,
            quantity: String(l.quantity),
            equipmentUnitId: l.equipment_unit_id,
            // Carry the operator the ticket captured through to the charge.
            // The charge line is what the incentive rule reads, so an operator
            // recorded on the ticket and dropped here would be captured and
            // still unpayable.
            employeeId: l.employee_id,
            costRate: hasSnapshot ? null : l.cost_rate,
            billRate: hasSnapshot ? null : l.bill_rate,
            rateSnapshot: hasSnapshot ? {
              rateVersionId: l.rate_version_id,
              baseUnit: l.base_unit ?? 'unit',
              baseQuantity: l.base_quantity ?? l.quantity,
              transactionUnitCode: l.unit,
              invoicePresentation: l.rate_presentation ?? 'summary',
              cost: { amount: l.cost_amount ?? mul(l.quantity, l.cost_rate ?? '0'), components: costComponents },
              bill: { amount: l.bill_amount ?? mul(l.quantity, l.bill_rate ?? '0'), components: billComponents },
            } : null,
            description: l.description,
            isBillable: true,
          }
        }),
      },
      { post: true },
    )
    await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
      values (${orgId}, ${ticketId}, ${charge.id}, 'created_from', ${userId}, ${userId})`)
    await db.execute(sql`
      update field_tickets
         set charge_document_id = ${charge.id}, updated_at = now(),
             updated_by = ${userId}
       where document_id = ${ticketId} and org_id = ${orgId}
         and charge_document_id is null
    `)
    chargeDocumentId = charge.id
  }

  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${userId}
     where id = ${ticketId} and org_id = ${orgId}`)
  await auditTicketLifecycle(orgId, ticketId, userId, 'approve', {
    source: previousStatus === 'pending_approval' ? 'flows' : 'submit_without_approval_flow',
    from: previousStatus,
    to: 'approved',
    timeEntries: laborSnapshot.lineCount,
    laborSnapshotId: laborSnapshot.id,
    laborSnapshotRevision: laborSnapshot.revision,
    operationalTimeStatusUnchanged: true,
    chargeDocumentId,
  })
}

/** Full ticket payload for the editor and the PDF. */
export async function loadFieldTicket(
  orgId: string,
  ticketId: string,
  opts: { includeRelated?: boolean } = {},
) {
  const doc = await loadHeader(orgId, ticketId)
  const snapshotResult = (await db.execute<{
      id: string
      revision: number
      evidence_basis: 'operational_time' | 'source_import' | 'controlled_amendment'
      reason: string
      source_system: string | null
      currency: string
      captured_at: string
    }>(sql`
    select id, revision, evidence_basis, reason, source_system, currency,
           captured_at::text as captured_at
      from field_ticket_labor_snapshots
     where org_id = ${orgId}
       and field_ticket_id = ${ticketId}
       and superseded_at is null
     limit 1
  `))
  const laborSnapshot = snapshotResult.rows[0] ?? null
  const entriesQuery = laborSnapshot
    ? db.execute(sql`
        select line.id, line.employee_party_id, line.employee_name,
               line.item_id, line.item_name,
               line.time_type_id, line.time_type_name,
               line.time_classification,
               coalesce(time_type.bill_multiplier, '1') as bill_multiplier,
               line.project_task_id, line.project_task_name,
               line.worked_on::text as worked_on, line.hours, line.bill_rate,
               coalesce(line.time_entry_status, 'snapshot') as status,
               line.time_entry_id, line.source_system, line.source_line_ref
          from field_ticket_labor_lines line
          left join time_types time_type
            on time_type.id = line.time_type_id
           and time_type.org_id = line.org_id
         where line.org_id = ${orgId}
           and line.snapshot_id = ${laborSnapshot.id}
           and line.field_ticket_id = ${ticketId}
         order by line.employee_name, line.item_name nulls first,
                  time_type.bill_multiplier, line.worked_on, line.sequence
      `)
    : db.execute(sql`
        select te.id, te.employee_party_id, p.display_name as employee_name,
               te.item_id, i.name as item_name,
               te.time_type_id, coalesce(tt.name, 'Unclassified') as time_type_name,
               coalesce(tt.classification, 'regular') as time_classification,
               coalesce(tt.bill_multiplier, '1') as bill_multiplier,
               te.project_task_id, pt.name as project_task_name,
               te.worked_on::text as worked_on, te.hours, te.bill_rate, te.status,
               te.id as time_entry_id, 'openbooks'::text as source_system,
               te.id::text as source_line_ref
          from time_entries te
          join parties p
            on p.id = te.employee_party_id
           and p.org_id = te.org_id
          left join items i
            on i.id = te.item_id
           and i.org_id = te.org_id
          left join time_types tt
            on tt.id = te.time_type_id
           and tt.org_id = te.org_id
          left join project_tasks pt
            on pt.id = te.project_task_id
           and pt.org_id = te.org_id
         where te.org_id = ${orgId}
           and te.field_ticket_id = ${ticketId}
         order by p.display_name, i.name nulls first,
                  tt.bill_multiplier, te.worked_on
      `)
  const [customer, project, foreman, entries, lines, signatureRows, requestRows, linkRows, billingRequestRows] = await Promise.all([
    db.execute<{ display_name: string; email: string | null }>(sql`
      select display_name, email from parties
       where id = coalesce(${doc.party_id}, (select customer_id from projects where id = ${doc.project_id} and org_id = ${orgId}))
         and org_id = ${orgId}`),
    db.execute<{ code: string | null; name: string }>(sql`select code, name from projects where id = ${doc.project_id} and org_id = ${orgId}`),
    db.execute<{ display_name: string }>(sql`select display_name from parties where id = ${doc.fieldTicket.foremanPartyId} and org_id = ${orgId}`),
    entriesQuery as unknown as Promise<{ rows: TicketEntryRow[] }>,
    db.execute<TicketLineRow>(sql`
      select dl.id, dl.item_id, i.name as item_name, dl.description, dl.quantity, dl.unit, dl.unit_price, dl.amount,
             dl.cost_rate, dl.bill_rate, dl.cost_amount, dl.bill_amount, dl.base_unit, dl.rate_version_id,
             dl.rate_presentation, dl.equipment_unit_id,
             case when eu.id is null then null else eu.unit_number || ' · ' || eu.name end as equipment_name,
             coalesce((select jsonb_agg(jsonb_build_object(
               'rateLineId', c.rate_line_id, 'unitCode', c.unit_code, 'unitName', c.unit_name,
               'quantity', c.quantity, 'rate', c.rate, 'amount', c.amount
             ) order by c.sequence) from charge_rate_components c
               where c.document_line_id = dl.id and c.org_id = dl.org_id and c.role = 'bill'), '[]'::jsonb) as rate_components
        from document_lines dl
        left join items i on i.id = dl.item_id and i.org_id = dl.org_id
        left join equipment_units eu on eu.id = dl.equipment_unit_id and eu.org_id = dl.org_id
       where dl.document_id = ${ticketId} and dl.org_id = ${orgId}
       order by dl.line_number`),
    db.execute<{
         role: 'foreman' | 'customer'
         signer_name: string
         comment: string | null
         signed_at: string
         version_id: string
         content_type: string
         storage_kind: string
         bytes: Buffer | null
       }>(sql`
      select s.role, s.signer_name, s.comment, s.signed_at::text as signed_at,
             fv.id as version_id, fv.content_type, fv.storage_kind, fb.bytes
        from field_ticket_signatures s
        join files f on f.id = s.signature_file_id and f.org_id = s.org_id
        join file_versions fv on fv.id = f.current_version_id
        left join file_blobs fb on fb.version_id = fv.id
       where s.org_id = ${orgId} and s.field_ticket_id = ${ticketId}
       order by s.signed_at`),
    db.execute<{
         recipient: string
         message: string | null
         sent_at: string
         expires_at: string
         responded_at: string | null
       }>(sql`
      select recipient, message, sent_at::text as sent_at,
             expires_at::text as expires_at, responded_at::text as responded_at
        from field_ticket_signature_requests
       where org_id = ${orgId} and field_ticket_id = ${ticketId}
         and sent_at is not null
       order by sent_at desc
       limit 1`),
    (opts.includeRelated === false ? Promise.resolve({ rows: [] }) : db.execute(sql`
      select 'from'::text as direction, link.link_type, related.id, related.kind,
             related.document_number, related.status
        from document_links link
        join documents related
          on related.id = link.from_document_id
         and related.org_id = link.org_id
       where link.to_document_id = ${ticketId}
         and link.org_id = ${orgId}
      union all
      select 'to'::text as direction, link.link_type, related.id, related.kind,
             related.document_number, related.status
        from document_links link
        join documents related
          on related.id = link.to_document_id
         and related.org_id = link.org_id
       where link.from_document_id = ${ticketId}
         and link.org_id = ${orgId}
       order by 1, 5
    `)) as unknown as Promise<{ rows: Array<{
      direction: 'from' | 'to'
      link_type: string
      id: string
      kind: string
      document_number: string
      status: string
    }> }>,
    (opts.includeRelated === false ? Promise.resolve({ rows: [] }) : db.execute(sql`
      select request.id,
             request.request_number as "requestNumber",
             request.status,
             selected.selected_at::text as "selectedAt",
             invoice.id as "invoiceDocumentId",
             invoice.document_number as "invoiceNumber",
             invoice.status as "invoiceStatus"
        from billing_request_field_tickets selected
        join billing_requests request
          on request.id = selected.billing_request_id
         and request.org_id = selected.org_id
        left join documents invoice
          on invoice.id = request.invoice_document_id
         and invoice.org_id = request.org_id
       where selected.org_id = ${orgId}
         and selected.field_ticket_id = ${ticketId}
       order by selected.selected_at desc, request.request_number desc
    `)) as unknown as Promise<{ rows: Array<{
      id: string
      requestNumber: string
      status: string
      selectedAt: string
      invoiceDocumentId: string | null
      invoiceNumber: string | null
      invoiceStatus: string | null
    }> }>,
  ])
  // Only live draft/pending entries receive a rate preview. Approved/signed
  // tickets render their captured values and never reinterpret history.
  const unpriced = laborSnapshot
    ? []
    : entries.rows.filter((e) => e.bill_rate == null).map((e) => e.id)
  const preview = unpriced.length ? await snapshotTimeBillRates(orgId, unpriced, { dryRun: true }) : new Map<string, string>()
  for (const e of entries.rows) if (e.bill_rate == null && preview.has(e.id)) e.bill_rate = preview.get(e.id)!
  const laborTotal = sum(
    entries.rows.map((e) => (e.bill_rate != null ? mul(String(e.hours), String(e.bill_rate)) : '0')),
  )
  const linesTotal = sum(lines.rows.map((l) => String(l.bill_amount ?? l.amount)))
  const signatures: { foreman?: TicketSignature; customer?: TicketSignature } = {}
  for (const signature of signatureRows.rows) {
    const bytes = signature.storage_kind === 's3'
      ? await getS3Blob(signature.version_id)
      : signature.bytes
    signatures[signature.role] = {
      image: bytes
        ? `data:${signature.content_type};base64,${Buffer.from(bytes).toString('base64')}`
        : null,
      name: signature.signer_name,
      comment: signature.comment,
      at: signature.signed_at,
    }
  }
  const latestRequest = requestRows.rows[0]
  const fieldTicket: FieldTicketData = {
    ...doc.fieldTicket,
    signatures: Object.keys(signatures).length ? signatures : undefined,
    send: latestRequest
      ? {
          to: latestRequest.recipient,
          message: latestRequest.message,
          sentAt: latestRequest.sent_at,
          expiresAt: latestRequest.expires_at,
          respondedAt: latestRequest.responded_at,
        }
      : undefined,
  }
  return {
    id: doc.id,
    documentNumber: doc.document_number,
    status: doc.status,
    documentDate: doc.document_date,
    referenceNumber: doc.reference_number,
    memo: doc.memo,
    customerId: doc.party_id,
    customerName: customer.rows[0]?.display_name ?? '',
    customerEmail: customer.rows[0]?.email ?? null,
    projectId: doc.project_id,
    projectName: project.rows[0] ? [project.rows[0].code, project.rows[0].name].filter(Boolean).join(' · ') : '',
    foremanName: foreman.rows[0]?.display_name ?? '',
    fieldTicket,
    entries: entries.rows,
    laborSnapshot,
    lines: lines.rows,
    laborTotal,
    linesTotal,
    grandTotal: add(laborTotal, linesTotal),
    links: linkRows.rows,
    billingRequests: billingRequestRows.rows,
  }
}

export interface TicketEntryRow {
  id: string
  employee_party_id: string
  employee_name: string
  item_id: string | null
  item_name: string | null
  time_type_id: string | null
  time_type_name: string
  time_classification: 'regular' | 'overtime' | 'double_time' | 'other'
  bill_multiplier: string
  project_task_id: string | null
  project_task_name: string | null
  worked_on: string
  hours: string
  bill_rate: string | null
  status: string
  time_entry_id: string | null
  source_system: string | null
  source_line_ref: string | null
}

export type TicketLineRow = {
  id: string
  item_id: string | null
  item_name: string | null
  description: string | null
  quantity: string
  unit: string | null
  unit_price: string
  amount: string
  cost_rate: string | null
  bill_rate: string | null
  cost_amount: string | null
  bill_amount: string | null
  base_unit: string | null
  rate_version_id: string | null
  rate_presentation: 'summary' | 'rate_components' | null
  equipment_unit_id: string | null
  equipment_name: string | null
  rate_components: { rateLineId: string | null; unitCode: string; unitName: string; quantity: string; rate: string; amount: string }[]
};
