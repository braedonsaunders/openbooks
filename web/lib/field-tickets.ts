import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { mul, divRate, add, sum } from '@openbooks/engine/src/money.ts'
import { nextDocumentNumber } from './bills'
import { createProjectCharge } from './project-charges'
import { runTimeApprovalEffects } from './time-approval'
import { resolveItemRate, snapshotTimeBillRates } from './item-rates'

/**
 * Field tickets — the signed crew timesheet for T&M work (the industry's
 * LEM sheet / field ticket / billable timesheet), native as a NON-POSTING
 * `documents` kind:
 *
 *   header    documents (kind 'field_ticket'), customer = party_id, job =
 *             project_id, ticket specifics under custom.fieldTicket
 *   hours     time_entries rows (field_ticket_id) — approval reuses the whole
 *             labor chain: rate snapshots, WIP posting, overhead pairs
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

export interface FieldTicketCustom {
  period: TicketPeriod
  periodStart: string
  periodEnd: string
  foremanPartyId: string | null
  signatures?: { foreman?: TicketSignature; customer?: TicketSignature }
  send?: { sentAt: string; expiresAt: string; message?: string | null; respondedAt?: string | null }
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

/** Resolve the ticket period: job (project.custom) > customer (party.custom) > org default > weekly. */
export async function resolveTicketPeriod(orgId: string, projectId: string | null): Promise<TicketPeriod> {
  const valid = (v: unknown): v is TicketPeriod => TICKET_PERIODS.includes(v as TicketPeriod)
  if (projectId) {
    const r = (await db.execute(sql`
      select p.custom->>'fieldTicketPeriod' as proj, cust.custom->>'fieldTicketPeriod' as cust
        from projects p
        left join parties cust on cust.id = p.customer_id
       where p.id = ${projectId} and p.org_id = ${orgId}`)) as unknown as {
      rows: { proj: string | null; cust: string | null }[]
    }
    const row = r.rows[0]
    if (valid(row?.proj)) return row!.proj as TicketPeriod
    if (valid(row?.cust)) return row!.cust as TicketPeriod
  }
  const o = (await db.execute(sql`
    select settings->'fieldTickets'->>'defaultPeriod' as p from orgs where id = ${orgId}`)) as unknown as {
    rows: { p: string | null }[]
  }
  return valid(o.rows[0]?.p) ? (o.rows[0]!.p as TicketPeriod) : 'weekly'
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
        (await db.execute(sql`
          select p.id, p.customer_id, p.subsidiary_id, p.custom->>'poNumber' as po
            from projects p where p.id = ${input.projectId} and p.org_id = ${orgId}`)) as unknown as {
          rows: { id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null }[]
        }
      ).rows[0] ?? null
    : null
  if (input.projectId && !proj) throw new FieldTicketError('Project not found')
  const period = input.period ?? (await resolveTicketPeriod(orgId, input.projectId ?? null))
  const window = ticketWindow(period, input.date ?? iso(new Date()))
  const org = (await db.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
    rows: { base_currency: string }[]
  }
  const foreman = (await db.execute(sql`select party_id from users where id = ${userId}`)) as unknown as {
    rows: { party_id: string | null }[]
  }
  const custom: { fieldTicket: FieldTicketCustom } = {
    fieldTicket: {
      period,
      periodStart: window.start,
      periodEnd: window.end,
      foremanPartyId: foreman.rows[0]?.party_id ?? null,
    },
  }
  const documentNumber = await nextDocumentNumber(orgId, 'field_ticket', 'FT-', proj?.subsidiary_id ?? undefined)
  const row = (await db.execute(sql`
    insert into documents (org_id, kind, document_number, document_date, currency, status, party_id, project_id,
                           subsidiary_id, reference_number, billing_method, subtotal, tax_total, total, custom, created_by)
    values (${orgId}, 'field_ticket', ${documentNumber}, ${window.end}, ${org.rows[0]?.base_currency ?? 'CAD'},
            'draft', ${proj?.customer_id ?? null}, ${proj?.id ?? null}, ${proj?.subsidiary_id ?? null},
            ${proj?.po ?? null}, 'time_and_materials', '0', '0', '0', ${JSON.stringify(custom)}, ${userId})
    returning id, document_number`)) as unknown as { rows: { id: string; document_number: string }[] }
  return { id: row.rows[0].id, documentNumber: row.rows[0].document_number }
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
  const ft = { ...doc.custom.fieldTicket }

  // Resolve every column ONCE in JS (a column may only be assigned once).
  let projChange: { id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null } | null = null
  if (patch.projectId !== undefined && patch.projectId !== doc.project_id) {
    if (!patch.projectId) throw new FieldTicketError('A ticket needs a project')
    const proj = (await db.execute(sql`
      select p.id, p.customer_id, p.subsidiary_id, p.custom->>'poNumber' as po
        from projects p where p.id = ${patch.projectId} and p.org_id = ${orgId}`)) as unknown as {
      rows: { id: string; customer_id: string | null; subsidiary_id: string | null; po: string | null }[]
    }
    if (!proj.rows[0]) throw new FieldTicketError('Project not found')
    projChange = proj.rows[0]
    // Re-resolve the period for the new job unless the caller pinned one.
    if (patch.period === undefined) {
      const resolved = await resolveTicketPeriod(orgId, projChange.id)
      if (resolved !== ft.period) patch.period = resolved
    }
  }

  const hourCount = (
    (await db.execute(sql`select count(*)::int as n from time_entries where field_ticket_id = ${ticketId}`)) as unknown as {
      rows: { n: number }[]
    }
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
      custom = jsonb_set(custom, '{fieldTicket}', ${JSON.stringify(ft)}::jsonb),
      updated_at = now(), updated_by = ${userId}
     where id = ${ticketId} and org_id = ${orgId}`)
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
  const ft = doc.custom.fieldTicket

  const existing = (await db.execute(sql`
    select id, employee_party_id, item_id, project_task_id, time_type_id, worked_on::text as worked_on, hours
      from time_entries where org_id = ${orgId} and field_ticket_id = ${ticketId}`)) as unknown as {
    rows: { id: string; employee_party_id: string; item_id: string | null; project_task_id: string | null; time_type_id: string; worked_on: string; hours: string }[]
  }
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
    const selectable = (await db.execute(sql`
      select id from time_types
       where org_id = ${orgId} and is_active and show_on_field_ticket
         and id = any(${`{${requestedTypeIds.join(',')}}`}::uuid[])`)) as unknown as { rows: { id: string }[] }
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
    const validTasks = (await db.execute(sql`
      select id from project_tasks where org_id = ${orgId} and project_id = ${doc.project_id}
        and id = any(${`{${requestedTaskIds.join(',')}}`}::uuid[])`)) as unknown as { rows: { id: string }[] }
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
  input: { itemId: string; quantity: number; rateUnitCode?: string | null; equipmentUnitId?: string | null; description?: string | null },
): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
  const item = (await db.execute(sql`
    select id, name, unit, default_rate, default_cost from items where id = ${input.itemId} and org_id = ${orgId}`)) as unknown as {
    rows: { id: string; name: string; unit: string | null; default_rate: string | null; default_cost: string | null }[]
  }
  if (!item.rows[0]) throw new FieldTicketError('Item not found')
  const qty = Number(input.quantity)
  if (!Number.isInteger(qty) || qty <= 0) throw new FieldTicketError('Quantity must be a positive whole number')

  if (!doc.project_id) throw new FieldTicketError('Choose a project before adding items')
  if (input.equipmentUnitId) {
    const equipment = (await db.execute(sql`
      select charge_item_id, status from equipment_units
       where id = ${input.equipmentUnitId} and org_id = ${orgId}`)) as unknown as {
      rows: { charge_item_id: string | null; status: string }[]
    }
    if (!equipment.rows[0] || equipment.rows[0].status !== 'active' || equipment.rows[0].charge_item_id !== input.itemId) {
      throw new FieldTicketError('Choose active equipment linked to this item')
    }
  }

  const quantity = String(qty)
  let resolved: Awaited<ReturnType<typeof resolveItemRate>>
  try {
    resolved = await resolveItemRate({
      orgId,
      projectId: doc.project_id,
      itemId: input.itemId,
      equipmentUnitId: input.equipmentUnitId,
      onDate: doc.custom.fieldTicket.periodEnd,
      baseQuantity: quantity,
      rateUnitCode: input.rateUnitCode,
    })
  } catch (error) {
    throw new FieldTicketError(error instanceof Error ? error.message : 'Could not resolve item rate')
  }
  const costAmount = resolved?.cost.amount ?? mul(quantity, String(item.rows[0].default_cost ?? '0'))
  const billAmount = resolved?.bill.amount ?? mul(quantity, String(item.rows[0].default_rate ?? item.rows[0].default_cost ?? '0'))
  const costRate = divRate(costAmount, quantity)
  const billRate = divRate(billAmount, quantity)
  const baseUnit = resolved?.baseUnit ?? item.rows[0].unit ?? 'unit'
  const baseQuantity = resolved?.baseQuantity ?? quantity
  const transactionUnit = resolved?.transactionUnitCode ?? item.rows[0].unit ?? 'unit'

  const next = (await db.execute(sql`
    select coalesce(max(line_number), 0) + 1 as n from document_lines where document_id = ${ticketId}`)) as unknown as {
    rows: { n: number }[]
  }
  const inserted = (await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount,
                                project_id, is_billable, equipment_unit_id, rate_version_id, rate_presentation,
                                base_quantity, base_unit, cost_rate, bill_rate, cost_amount, bill_amount, created_by, updated_by)
    values (${orgId}, ${ticketId}, ${next.rows[0].n}, ${input.itemId}, ${input.description ?? item.rows[0].name},
            ${quantity}, ${transactionUnit}, ${billRate}, ${billAmount}, ${doc.project_id}, true, ${input.equipmentUnitId ?? null},
            ${resolved?.rateVersionId ?? null}, ${resolved?.invoicePresentation ?? 'summary'}, ${baseQuantity}, ${baseUnit},
            ${costRate}, ${billRate}, ${costAmount}, ${billAmount}, ${userId}, ${userId}) returning id`)) as unknown as {
    rows: { id: string }[]
  }
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
      from (select coalesce(sum(amount), 0) as amt from document_lines where document_id = ${ticketId}) x
     where d.id = ${ticketId} and d.org_id = ${orgId}`)
}

interface HeaderRow {
  id: string
  document_number: string
  status: string
  party_id: string | null
  project_id: string | null
  document_date: string
  reference_number: string | null
  memo: string | null
  custom: { fieldTicket: FieldTicketCustom }
}

async function loadHeader(orgId: string, ticketId: string): Promise<HeaderRow> {
  const r = (await db.execute(sql`
    select id, document_number, status, party_id, project_id, document_date::text as document_date, reference_number, memo, custom
      from documents where id = ${ticketId} and org_id = ${orgId} and kind = 'field_ticket'`)) as unknown as {
    rows: HeaderRow[]
  }
  if (!r.rows[0]) throw new FieldTicketError('Ticket not found')
  const row = r.rows[0]
  if (!row.custom?.fieldTicket) throw new FieldTicketError('Ticket is malformed (missing fieldTicket data)')
  return row
}

export async function patchTicketCustom(
  orgId: string,
  ticketId: string,
  patch: Partial<FieldTicketCustom>,
): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  const next = { ...doc.custom.fieldTicket, ...patch }
  await db.execute(sql`
    update documents set custom = jsonb_set(custom, '{fieldTicket}', ${JSON.stringify(next)}::jsonb), updated_at = now()
     where id = ${ticketId} and org_id = ${orgId}`)
}

/** Submit: draft → pending_approval (validates the ticket isn't empty). */
export async function submitFieldTicket(orgId: string, userId: string, ticketId: string): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'draft') throw new FieldTicketError('Only draft tickets can be submitted')
  const counts = (await db.execute(sql`
    select (select count(*) from time_entries where field_ticket_id = ${ticketId}) as hours,
           (select count(*) from document_lines where document_id = ${ticketId}) as lines`)) as unknown as {
    rows: { hours: number; lines: number }[]
  }
  if (Number(counts.rows[0].hours) === 0 && Number(counts.rows[0].lines) === 0) {
    throw new FieldTicketError('Add hours or lines before submitting')
  }
  await db.execute(sql`
    update time_entries set status = 'submitted', updated_at = now(), updated_by = ${userId}
     where org_id = ${orgId} and field_ticket_id = ${ticketId} and status = 'draft'`)
  await db.execute(sql`
    update documents set status = 'pending_approval', updated_at = now(), updated_by = ${userId}
     where id = ${ticketId} and org_id = ${orgId}`)
}

/**
 * Approve: hours become approved time (full labor chain fires), item lines
 * materialize as a POSTED project_charge (job cost + billing sweep), the
 * ticket locks. Both provenance directions recorded via document_links.
 */
export async function approveFieldTicket(orgId: string, userId: string, ticketId: string): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'pending_approval') throw new FieldTicketError('Only submitted tickets can be approved')

  const entries = (await db.execute(sql`
    update time_entries set status = 'approved', approved_by = ${userId}, approved_at = now(),
           updated_at = now(), updated_by = ${userId}
     where org_id = ${orgId} and field_ticket_id = ${ticketId} and status = 'submitted'
     returning id`)) as unknown as { rows: { id: string }[] }
  try {
    await runTimeApprovalEffects(orgId, userId, entries.rows.map((r) => r.id))
  } catch (e) {
    console.error('[field-tickets] approval effects failed (entries stay re-postable):', (e as Error).message)
  }

  // Materialize item lines as a project charge so job cost + T&M billing see them.
  const lines = (await db.execute(sql`
    select id, item_id, description, quantity, unit, cost_rate, bill_rate, cost_amount, bill_amount,
           equipment_unit_id, rate_version_id, rate_presentation, base_quantity, base_unit
      from document_lines
     where document_id = ${ticketId} and org_id = ${orgId} and item_id is not null`)) as unknown as {
    rows: { id: string; item_id: string; description: string | null; quantity: string; unit: string | null; cost_rate: string | null;
      bill_rate: string | null; cost_amount: string | null; bill_amount: string | null; equipment_unit_id: string | null;
      rate_version_id: string | null; rate_presentation: 'summary' | 'rate_components' | null;
      base_quantity: string | null; base_unit: string | null }[]
  }
  if (lines.rows.length > 0 && doc.project_id) {
    const lineIds = `{${lines.rows.map((line) => line.id).join(',')}}`
    const componentRows = (await db.execute(sql`
      select document_line_id, role, rate_line_id, unit_code, unit_name, quantity, rate, amount
        from charge_rate_components
       where org_id = ${orgId} and document_line_id = any(${lineIds}::uuid[])
       order by document_line_id, role, sequence`)) as unknown as {
      rows: { document_line_id: string; role: 'cost' | 'bill'; rate_line_id: string | null; unit_code: string;
        unit_name: string; quantity: string; rate: string; amount: string }[]
    }
    const componentsFor = (lineId: string, role: 'cost' | 'bill') => componentRows.rows
      .filter((component) => component.document_line_id === lineId && component.role === role)
      .map((component) => ({ rateLineId: component.rate_line_id, unitCode: component.unit_code,
        unitName: component.unit_name, quantity: component.quantity, rate: component.rate, amount: component.amount }))
    const charge = await createProjectCharge(
      orgId,
      userId,
      {
        projectId: doc.project_id,
        referenceNumber: doc.document_number,
        documentDate: doc.custom.fieldTicket.periodEnd,
        lines: lines.rows.map((l) => {
          const costComponents = componentsFor(l.id, 'cost')
          const billComponents = componentsFor(l.id, 'bill')
          const hasSnapshot = costComponents.length > 0 && billComponents.length > 0
          return {
            itemId: l.item_id,
            quantity: String(l.quantity),
            equipmentUnitId: l.equipment_unit_id,
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
      insert into document_links (org_id, from_document_id, to_document_id, kind)
      values (${orgId}, ${ticketId}, ${charge.id}, 'created_from')`)
    await patchTicketCustom(orgId, ticketId, { chargeDocumentId: charge.id })
  }

  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${userId}
     where id = ${ticketId} and org_id = ${orgId}`)
}

/** Reject: back to draft with the reason recorded; hours reopen. */
export async function rejectFieldTicket(orgId: string, userId: string, ticketId: string, reason: string): Promise<void> {
  const doc = await loadHeader(orgId, ticketId)
  if (doc.status !== 'pending_approval') throw new FieldTicketError('Only submitted tickets can be rejected')
  await db.execute(sql`
    update time_entries set status = 'draft', updated_at = now(), updated_by = ${userId}
     where org_id = ${orgId} and field_ticket_id = ${ticketId} and status = 'submitted'`)
  await db.execute(sql`
    update documents set status = 'draft', updated_at = now(), updated_by = ${userId},
           custom = jsonb_set(custom, '{fieldTicket,rejectionReason}', ${JSON.stringify(reason.slice(0, 500))}::jsonb)
     where id = ${ticketId} and org_id = ${orgId}`)
}

/** Full ticket payload for the editor and the PDF. */
export async function loadFieldTicket(orgId: string, ticketId: string) {
  const doc = await loadHeader(orgId, ticketId)
  const [customer, project, foreman, entries, lines] = await Promise.all([
    db.execute(sql`
      select display_name, email from parties
       where id = coalesce(${doc.party_id}, (select customer_id from projects where id = ${doc.project_id} and org_id = ${orgId}))
         and org_id = ${orgId}`) as unknown as Promise<{ rows: { display_name: string; email: string | null }[] }>,
    db.execute(sql`select code, name from projects where id = ${doc.project_id}`) as unknown as Promise<{ rows: { code: string | null; name: string }[] }>,
    db.execute(sql`select display_name from parties where id = ${doc.custom.fieldTicket.foremanPartyId}`) as unknown as Promise<{ rows: { display_name: string }[] }>,
    db.execute(sql`
      select te.id, te.employee_party_id, p.display_name as employee_name, te.item_id, i.name as item_name,
             te.time_type_id, tt.name as time_type_name, coalesce(tt.bill_multiplier, '1') as bill_multiplier,
             te.project_task_id, pt.name as project_task_name,
             te.worked_on::text as worked_on, te.hours, te.bill_rate, te.status
        from time_entries te
        join parties p on p.id = te.employee_party_id
        left join items i on i.id = te.item_id
        left join time_types tt on tt.id = te.time_type_id
        left join project_tasks pt on pt.id = te.project_task_id
       where te.org_id = ${orgId} and te.field_ticket_id = ${ticketId}
       order by p.display_name, i.name nulls first, tt.bill_multiplier, te.worked_on`) as unknown as Promise<{ rows: TicketEntryRow[] }>,
    db.execute(sql`
      select dl.id, dl.item_id, i.name as item_name, dl.description, dl.quantity, dl.unit, dl.unit_price, dl.amount,
             dl.cost_rate, dl.bill_rate, dl.cost_amount, dl.bill_amount, dl.base_unit, dl.rate_version_id,
             dl.rate_presentation, dl.equipment_unit_id,
             case when eu.id is null then null else eu.unit_number || ' · ' || eu.name end as equipment_name,
             coalesce((select jsonb_agg(jsonb_build_object(
               'rateLineId', c.rate_line_id, 'unitCode', c.unit_code, 'unitName', c.unit_name,
               'quantity', c.quantity, 'rate', c.rate, 'amount', c.amount
             ) order by c.sequence) from charge_rate_components c
               where c.document_line_id = dl.id and c.role = 'bill'), '[]'::jsonb) as rate_components
        from document_lines dl
        left join items i on i.id = dl.item_id
        left join equipment_units eu on eu.id = dl.equipment_unit_id
       where dl.document_id = ${ticketId} and dl.org_id = ${orgId}
       order by dl.line_number`) as unknown as Promise<{ rows: TicketLineRow[] }>,
  ])
  // Draft entries have no bill-rate snapshot yet — resolve a live preview so
  // the ticket shows money before approval (approval stamps the real ones).
  const unpriced = entries.rows.filter((e) => e.bill_rate == null).map((e) => e.id)
  const preview = unpriced.length ? await snapshotTimeBillRates(orgId, unpriced, { dryRun: true }) : new Map<string, string>()
  for (const e of entries.rows) if (e.bill_rate == null && preview.has(e.id)) e.bill_rate = preview.get(e.id)!
  const laborTotal = sum(
    entries.rows.map((e) => (e.bill_rate != null ? mul(String(e.hours), String(e.bill_rate)) : '0')),
  )
  const linesTotal = sum(lines.rows.map((l) => String(l.bill_amount ?? l.amount)))
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
    fieldTicket: doc.custom.fieldTicket,
    entries: entries.rows,
    lines: lines.rows,
    laborTotal,
    linesTotal,
    grandTotal: add(laborTotal, linesTotal),
  }
}

export interface TicketEntryRow {
  id: string
  employee_party_id: string
  employee_name: string
  item_id: string | null
  item_name: string | null
  time_type_id: string
  time_type_name: string
  bill_multiplier: string
  project_task_id: string | null
  project_task_name: string | null
  worked_on: string
  hours: string
  bill_rate: string | null
  status: string
}

export interface TicketLineRow {
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
}
