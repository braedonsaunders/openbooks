import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, cmp, normalizeMoney, roundMoney, sum } from '@openbooks/engine/src/money.ts'
import { computeLineTaxes } from '@openbooks/engine/src/tax.ts'
import {
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from '@openbooks/engine/src/tax-persist.ts'
import { nextDocumentNumber } from './bills'

export type WipSourceType = 'time_entry' | 'document_line'
export type PrebillStatus = 'draft' | 'review' | 'approved' | 'converted' | 'void'

export class WipBillingError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'WipBillingError'
  }
}

export interface CreatePrebillInput {
  projectId: string
  periodStart?: string | null
  periodEnd: string
  notes?: string | null
}

export interface UpdatePrebillLineInput {
  proposedBillAmount: string
  adjustmentReason?: string | null
  adjustmentEvidence?: string[]
}

export interface PrebillListRow {
  id: string
  worksheetNumber: string
  projectId: string
  projectName: string
  customerName: string | null
  periodStart: string | null
  periodEnd: string
  status: PrebillStatus
  originalBillAmount: string
  proposedBillAmount: string
  costAmount: string
  adjustmentAmount: string
  billingRequestId: string | null
  invoiceDocumentId: string | null
  invoiceNumber: string | null
  createdAt: string
}

export interface PrebillLineRow {
  id: string
  lineNumber: number
  sourceType: WipSourceType
  timeEntryId: string | null
  documentLineId: string | null
  sourceDocumentId: string | null
  sourceDate: string
  description: string | null
  quantity: string
  unit: string | null
  costAmount: string
  originalBillAmount: string
  proposedBillAmount: string
  adjustmentAmount: string
  adjustmentReason: string | null
  adjustmentEvidence: string[]
  disposition: 'bill' | 'hold'
  holdId: string | null
  holdReason: string | null
}

export interface PrebillDetail extends PrebillListRow {
  notes: string | null
  submittedAt: string | null
  approvedAt: string | null
  convertedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  lines: PrebillLineRow[]
  events: Array<{ id: string; eventType: string; actorName: string | null; occurredAt: string; details: unknown }>
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function requireDate(value: string, label: string): string {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new WipBillingError(`${label} must be a valid date`)
  }
  return value
}

function evidenceList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20)
}

async function appendEvent(
  tx: Tx,
  orgId: string,
  prebillId: string,
  actorId: string,
  eventType: string,
  details: Record<string, unknown> = {},
) {
  await tx.execute(sql`
    insert into wip_prebill_events (org_id, prebill_id, event_type, actor_id, details)
    values (${orgId}, ${prebillId}, ${eventType}, ${JSON.stringify(details)}::jsonb)
  `)
}

async function audit(
  tx: Tx,
  orgId: string,
  tableName: string,
  rowId: string,
  actorId: string,
  changes: Record<string, unknown>,
) {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${tableName}, ${rowId}, 'update', ${JSON.stringify(changes)}::jsonb, ${actorId})
  `)
}

async function refreshTotals(tx: Tx, orgId: string, prebillId: string, actorId: string) {
  await tx.execute(sql`
    update wip_prebills worksheet
       set original_bill_amount = totals.original_bill,
           proposed_bill_amount = totals.proposed_bill,
           cost_amount = totals.cost,
           adjustment_amount = totals.proposed_bill - totals.original_bill,
           updated_at = now(),
           updated_by = ${actorId}
      from (
        select coalesce(sum(original_bill_amount) filter (where disposition = 'bill'), 0) as original_bill,
               coalesce(sum(proposed_bill_amount) filter (where disposition = 'bill'), 0) as proposed_bill,
               coalesce(sum(cost_amount) filter (where disposition = 'bill'), 0) as cost
          from wip_prebill_lines
         where org_id = ${orgId} and prebill_id = ${prebillId}
      ) totals
     where worksheet.org_id = ${orgId} and worksheet.id = ${prebillId}
  `)
}

/**
 * Snapshot every eligible source through a cutoff. A project advisory lock plus
 * an active-worksheet exclusion prevents two reviewers from reserving the same
 * unbilled work concurrently.
 */
export async function createPrebill(orgId: string, actorId: string, input: CreatePrebillInput) {
  const periodEnd = requireDate(input.periodEnd, 'Period end')
  const periodStart = input.periodStart ? requireDate(input.periodStart, 'Period start') : null
  if (periodStart && periodStart > periodEnd) throw new WipBillingError('Period start must be on or before period end')

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wip-prebill:${orgId}:${input.projectId}`}, 0))`)
    const project = (await tx.execute(sql`
      select id from projects where org_id = ${orgId} and id = ${input.projectId} and status <> 'cancelled'
    `)) as unknown as { rows: { id: string }[] }
    if (!project.rows[0]) throw new WipBillingError('Project not found', 404)

    const numberRow = (await tx.execute(sql`
      select coalesce(max((regexp_replace(worksheet_number, '\\D', '', 'g'))::bigint), 0) as n
        from wip_prebills
       where org_id = ${orgId} and worksheet_number ~ '^WIP-[0-9]+$'
    `)) as unknown as { rows: { n: string }[] }
    const worksheetNumber = `WIP-${String(Number(numberRow.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`
    const created = (await tx.execute(sql`
      insert into wip_prebills (
        org_id, project_id, worksheet_number, period_start, period_end, notes,
        status, created_by, updated_by
      ) values (
        ${orgId}, ${input.projectId}, ${worksheetNumber}, ${periodStart}, ${periodEnd},
        ${input.notes?.trim() || null}, 'draft', ${actorId}, ${actorId}
      ) returning id, worksheet_number as "worksheetNumber"
    `)) as unknown as { rows: { id: string; worksheetNumber: string }[] }
    const prebill = created.rows[0]!

    const eligible = (await tx.execute(sql`
      with candidates as (
        select 'time_entry'::text as source_type,
               te.id as source_id,
               te.id as time_entry_id,
               null::uuid as document_line_id,
               null::uuid as source_document_id,
               te.worked_on as source_date,
               coalesce(te.memo, item.name, 'Time') as description,
               te.hours as quantity,
               'hours'::text as unit,
               te.item_id,
               item.income_account_id,
               item.tax_code_id,
               te.employee_party_id,
               te.time_type_id,
               te.department_id,
               round(te.hours * coalesce(te.cost_rate, 0), 4) as cost_amount,
               round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4) as bill_amount
          from time_entries te
          left join items item on item.org_id = te.org_id and item.id = te.item_id
         where te.org_id = ${orgId}
           and te.project_id = ${input.projectId}
           and te.status = 'approved'
           and te.is_billable
           and te.billing_status = 'unbilled'
           and te.worked_on <= ${periodEnd}
           and (${periodStart}::date is null or te.worked_on >= ${periodStart})
        union all
        select 'document_line'::text as source_type,
               line.id as source_id,
               null::uuid as time_entry_id,
               line.id as document_line_id,
               doc.id as source_document_id,
               doc.document_date as source_date,
               coalesce(line.description, item.name, doc.document_number) as description,
               case when doc.kind = 'project_charge' then line.quantity else 1 end as quantity,
               line.unit,
               line.item_id,
               item.income_account_id,
               item.tax_code_id,
               null::uuid as employee_party_id,
               null::uuid as time_type_id,
               coalesce(line.department_id, doc.department_id) as department_id,
               case when doc.kind = 'project_charge' then coalesce(line.cost_amount, line.amount) else line.amount end as cost_amount,
               case
                 when doc.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                 when line.markup_percent is not null then round(line.amount * (1 + line.markup_percent / 100), 4)
                 else round(line.amount * coalesce(nullif(line.cost_multiplier, 0), 1), 4)
               end as bill_amount
          from document_lines line
          join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
          left join items item on item.org_id = line.org_id and item.id = line.item_id
         where line.org_id = ${orgId}
           and coalesce(line.project_id, doc.project_id) = ${input.projectId}
           and line.is_billable
           and line.billed_by_line_id is null
           and doc.document_date <= ${periodEnd}
           and (${periodStart}::date is null or doc.document_date >= ${periodStart})
           and ((doc.kind = 'project_charge' and doc.status in ('approved', 'posted'))
             or (doc.status = 'posted' and doc.kind in ('vendor_bill', 'expense_report', 'card_charge', 'check')))
      )
      select candidate.*
        from candidates candidate
       where not exists (
               select 1 from wip_holds hold
                where hold.org_id = ${orgId}
                  and hold.source_type = candidate.source_type
                  and hold.source_id = candidate.source_id
                  and hold.released_at is null
             )
         and not exists (
               select 1
                 from wip_prebill_lines reserved
                 join wip_prebills worksheet
                   on worksheet.org_id = reserved.org_id and worksheet.id = reserved.prebill_id
                where reserved.org_id = ${orgId}
                  and reserved.source_type = candidate.source_type
                  and coalesce(reserved.time_entry_id, reserved.document_line_id) = candidate.source_id
                  and worksheet.status in ('draft', 'review', 'approved')
             )
       order by candidate.source_date, candidate.source_type, candidate.source_id
    `)) as unknown as { rows: Record<string, any>[] }

    let lineNumber = 1
    for (const source of eligible.rows) {
      await tx.execute(sql`
        insert into wip_prebill_lines (
          org_id, prebill_id, project_id, line_number, source_type, time_entry_id,
          document_line_id, source_document_id, source_date, description, quantity, unit,
          item_id, income_account_id, tax_code_id, employee_party_id, time_type_id,
          department_id, cost_amount, original_bill_amount, proposed_bill_amount,
          adjustment_amount, disposition, created_by, updated_by
        ) values (
          ${orgId}, ${prebill.id}, ${input.projectId}, ${lineNumber++}, ${source.source_type},
          ${source.time_entry_id}, ${source.document_line_id}, ${source.source_document_id},
          ${source.source_date}, ${source.description}, ${source.quantity}, ${source.unit},
          ${source.item_id}, ${source.income_account_id}, ${source.tax_code_id},
          ${source.employee_party_id}, ${source.time_type_id}, ${source.department_id},
          ${source.cost_amount}, ${source.bill_amount}, ${source.bill_amount}, '0', 'bill',
          ${actorId}, ${actorId}
        )
      `)
    }
    await refreshTotals(tx, orgId, prebill.id, actorId)
    await appendEvent(tx, orgId, prebill.id, actorId, 'created', { sourceCount: eligible.rows.length, periodStart, periodEnd })
    await audit(tx, orgId, 'wip_prebills', prebill.id, actorId, { after: { worksheetNumber, status: 'draft' } })
    return { ...prebill, sourceCount: eligible.rows.length }
  })
}

export async function listPrebills(orgId: string, projectId?: string): Promise<PrebillListRow[]> {
  const result = (await db.execute(sql`
    select worksheet.id,
           worksheet.worksheet_number as "worksheetNumber",
           worksheet.project_id as "projectId",
           project.name as "projectName",
           customer.display_name as "customerName",
           worksheet.period_start::text as "periodStart",
           worksheet.period_end::text as "periodEnd",
           worksheet.status,
           worksheet.original_bill_amount::text as "originalBillAmount",
           worksheet.proposed_bill_amount::text as "proposedBillAmount",
           worksheet.cost_amount::text as "costAmount",
           worksheet.adjustment_amount::text as "adjustmentAmount",
           worksheet.billing_request_id as "billingRequestId",
           worksheet.invoice_document_id as "invoiceDocumentId",
           invoice.document_number as "invoiceNumber",
           worksheet.created_at as "createdAt"
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId}
       and (${projectId ?? null}::uuid is null or worksheet.project_id = ${projectId ?? null})
     order by worksheet.created_at desc
  `)) as unknown as { rows: PrebillListRow[] }
  return result.rows
}

export async function loadPrebill(orgId: string, id: string): Promise<PrebillDetail | null> {
  const headers = await listPrebills(orgId)
  const header = headers.find((row) => row.id === id)
  if (!header) return null
  const [lineResult, eventResult, detailResult] = await Promise.all([
    db.execute(sql`
      select line.id, line.line_number as "lineNumber", line.source_type as "sourceType",
             line.time_entry_id as "timeEntryId", line.document_line_id as "documentLineId",
             line.source_document_id as "sourceDocumentId", line.source_date::text as "sourceDate",
             line.description, line.quantity::text, line.unit, line.cost_amount::text as "costAmount",
             line.original_bill_amount::text as "originalBillAmount",
             line.proposed_bill_amount::text as "proposedBillAmount",
             line.adjustment_amount::text as "adjustmentAmount",
             line.adjustment_reason as "adjustmentReason",
             line.adjustment_evidence as "adjustmentEvidence", line.disposition,
             hold.id as "holdId", hold.reason as "holdReason"
        from wip_prebill_lines line
        left join lateral (
          select id, reason from wip_holds
           where org_id = line.org_id and source_type = line.source_type
             and source_id = coalesce(line.time_entry_id, line.document_line_id)
             and released_at is null
           order by held_at desc limit 1
        ) hold on true
       where line.org_id = ${orgId} and line.prebill_id = ${id}
       order by line.line_number
    `),
    db.execute(sql`
      select event.id, event.event_type as "eventType", coalesce(actor.name, actor.email) as "actorName",
             event.occurred_at as "occurredAt", event.details
        from wip_prebill_events event
        left join users actor on actor.id = event.actor_id
       where event.org_id = ${orgId} and event.prebill_id = ${id}
       order by event.occurred_at, event.id
    `),
    db.execute(sql`
      select notes, submitted_at as "submittedAt", approved_at as "approvedAt",
             converted_at as "convertedAt", voided_at as "voidedAt", void_reason as "voidReason"
        from wip_prebills where org_id = ${orgId} and id = ${id}
    `),
  ]) as unknown as [{ rows: PrebillLineRow[] }, { rows: PrebillDetail['events'] }, { rows: Pick<PrebillDetail, 'notes' | 'submittedAt' | 'approvedAt' | 'convertedAt' | 'voidedAt' | 'voidReason'>[] }]
  return { ...header, ...detailResult.rows[0]!, lines: lineResult.rows, events: eventResult.rows }
}

export async function updatePrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  input: UpdatePrebillLineInput,
) {
  const proposed = normalizeMoney(input.proposedBillAmount)
  if (cmp(proposed, '0') < 0) throw new WipBillingError('Proposed billing cannot be negative')
  const evidence = evidenceList(input.adjustmentEvidence)
  return db.transaction(async (tx) => {
    const current = (await tx.execute(sql`
      select line.proposed_bill_amount::text as proposed, line.original_bill_amount::text as original,
             worksheet.status
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
       for update
    `)) as unknown as { rows: { proposed: string; original: string; status: PrebillStatus }[] }
    const before = current.rows[0]
    if (!before) throw new WipBillingError('Prebill line not found', 404)
    if (before.status !== 'draft') throw new WipBillingError('Only a draft prebill can be edited')
    const changed = cmp(proposed, before.original) !== 0
    const reason = input.adjustmentReason?.trim() || null
    if (changed && !reason) throw new WipBillingError('A reason is required for a write-up or write-down')
    if (changed && evidence.length === 0) throw new WipBillingError('Evidence is required for a write-up or write-down')
    await tx.execute(sql`
      update wip_prebill_lines
         set proposed_bill_amount = ${proposed},
             adjustment_amount = ${proposed}::numeric - original_bill_amount,
             adjustment_reason = ${changed ? reason : null},
             adjustment_evidence = ${JSON.stringify(changed ? evidence : [])}::jsonb,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and prebill_id = ${prebillId} and id = ${lineId}
    `)
    await refreshTotals(tx, orgId, prebillId, actorId)
    await appendEvent(tx, orgId, prebillId, actorId, 'line_updated', {
      lineId,
      before: before.proposed,
      after: proposed,
      reason: changed ? reason : null,
      evidence: changed ? evidence : [],
    })
    await audit(tx, orgId, 'wip_prebill_lines', lineId, actorId, { before: { proposed: before.proposed }, after: { proposed } })
    return { id: lineId, proposedBillAmount: proposed }
  })
}

export async function holdPrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  reason: string,
  evidence: string[] = [],
) {
  const cleanReason = reason.trim()
  if (!cleanReason) throw new WipBillingError('A hold reason is required')
  const cleanEvidence = evidenceList(evidence)
  return db.transaction(async (tx) => {
    const row = (await tx.execute(sql`
      select line.source_type, coalesce(line.time_entry_id, line.document_line_id) as source_id,
             line.project_id, worksheet.status
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
       for update
    `)) as unknown as { rows: { source_type: WipSourceType; source_id: string; project_id: string; status: PrebillStatus }[] }
    const source = row.rows[0]
    if (!source) throw new WipBillingError('Prebill line not found', 404)
    if (source.status !== 'draft') throw new WipBillingError('Only a draft prebill can be changed')
    const existing = (await tx.execute(sql`
      select id from wip_holds
       where org_id = ${orgId} and source_type = ${source.source_type}
         and source_id = ${source.source_id} and released_at is null
       for update
    `)) as unknown as { rows: { id: string }[] }
    let holdId = existing.rows[0]?.id
    if (!holdId) {
      const inserted = (await tx.execute(sql`
        insert into wip_holds (
          org_id, project_id, source_type, source_id, reason, evidence, held_by,
          created_by, updated_by
        ) values (
          ${orgId}, ${source.project_id}, ${source.source_type}, ${source.source_id},
          ${cleanReason}, ${JSON.stringify(cleanEvidence)}::jsonb, ${actorId}, ${actorId}, ${actorId}
        ) returning id
      `)) as unknown as { rows: { id: string }[] }
      holdId = inserted.rows[0]!.id
    }
    await tx.execute(sql`
      update wip_prebill_lines set disposition = 'hold', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${lineId}
    `)
    await refreshTotals(tx, orgId, prebillId, actorId)
    await appendEvent(tx, orgId, prebillId, actorId, 'hold_created', { lineId, holdId, reason: cleanReason, evidence: cleanEvidence })
    return { id: holdId }
  })
}

export async function releaseWipHold(orgId: string, actorId: string, holdId: string, reason: string) {
  const releaseReason = reason.trim()
  if (!releaseReason) throw new WipBillingError('A release reason is required')
  return db.transaction(async (tx) => {
    const released = (await tx.execute(sql`
      update wip_holds
         set released_at = now(), released_by = ${actorId}, release_reason = ${releaseReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${holdId} and released_at is null
       returning source_type, source_id
    `)) as unknown as { rows: { source_type: WipSourceType; source_id: string }[] }
    const source = released.rows[0]
    if (!source) throw new WipBillingError('Active hold not found', 404)
    const prebillRows = (await tx.execute(sql`
      update wip_prebill_lines line
         set disposition = 'bill', updated_at = now(), updated_by = ${actorId}
        from wip_prebills worksheet
       where line.org_id = ${orgId}
         and worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
         and worksheet.status = 'draft'
         and line.source_type = ${source.source_type}
         and coalesce(line.time_entry_id, line.document_line_id) = ${source.source_id}
       returning line.prebill_id
    `)) as unknown as { rows: { prebill_id: string }[] }
    for (const row of prebillRows.rows) {
      await refreshTotals(tx, orgId, row.prebill_id, actorId)
      await appendEvent(tx, orgId, row.prebill_id, actorId, 'hold_released', { holdId, reason: releaseReason })
    }
    await audit(tx, orgId, 'wip_holds', holdId, actorId, { after: { releasedAt: 'now', releaseReason } })
    return { id: holdId }
  })
}

export async function transitionPrebill(
  orgId: string,
  actorId: string,
  id: string,
  action: 'submit' | 'return' | 'approve' | 'void',
  reason?: string,
) {
  const transitions: Record<typeof action, { from: PrebillStatus[]; to: PrebillStatus; event: string }> = {
    submit: { from: ['draft'], to: 'review', event: 'submitted' },
    return: { from: ['review'], to: 'draft', event: 'returned' },
    approve: { from: ['review'], to: 'approved', event: 'approved' },
    void: { from: ['draft', 'review', 'approved'], to: 'void', event: 'voided' },
  }
  const rule = transitions[action]
  if ((action === 'return' || action === 'void') && !reason?.trim()) {
    throw new WipBillingError('A reason is required')
  }
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      select status, submitted_by, created_by from wip_prebills
       where org_id = ${orgId} and id = ${id}
       for update
    `)) as unknown as { rows: { status: PrebillStatus; submitted_by: string | null; created_by: string | null }[] }
    const header = locked.rows[0]
    if (!header) throw new WipBillingError('Prebill not found', 404)
    const current = (await tx.execute(sql`
      select count(*) filter (where disposition = 'bill')::int as bill_lines,
             count(*) filter (
               where disposition = 'bill'
                 and proposed_bill_amount <> original_bill_amount
                 and (nullif(trim(adjustment_reason), '') is null
                   or jsonb_array_length(adjustment_evidence) = 0)
             )::int as unsupported_adjustments
        from wip_prebill_lines
       where org_id = ${orgId} and prebill_id = ${id}
    `)) as unknown as { rows: { bill_lines: number; unsupported_adjustments: number }[] }
    const worksheet = { ...header, ...current.rows[0]! }
    if (!rule.from.includes(worksheet.status)) throw new WipBillingError(`Cannot ${action} a ${worksheet.status} prebill`)
    if (action === 'approve' && (header.submitted_by ?? header.created_by) === actorId) {
      throw new WipBillingError('The submitter cannot approve this prebill')
    }
    if (action === 'submit' && worksheet.bill_lines === 0) throw new WipBillingError('A prebill must contain at least one billable line')
    if ((action === 'submit' || action === 'approve') && worksheet.unsupported_adjustments > 0) {
      throw new WipBillingError('Every write-up and write-down requires a reason and evidence')
    }
    const workflowColumns = action === 'submit'
      ? sql`, submitted_at = now(), submitted_by = ${actorId}`
      : action === 'approve'
        ? sql`, approved_at = now(), approved_by = ${actorId}`
        : action === 'void'
          ? sql`, voided_at = now(), voided_by = ${actorId}, void_reason = ${reason!.trim()}`
          : sql``
    await tx.execute(sql`
      update wip_prebills
         set status = ${rule.to}, updated_at = now(), updated_by = ${actorId}${workflowColumns}
       where org_id = ${orgId} and id = ${id}
    `)
    await appendEvent(tx, orgId, id, actorId, rule.event, reason?.trim() ? { reason: reason.trim() } : {})
    await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: worksheet.status }, after: { status: rule.to }, reason: reason?.trim() })
    return { id, status: rule.to }
  })
}

/**
 * Convert an approved worksheet into the existing billing-request and document
 * model. Exact source rows are locked and stamped in the same transaction as
 * the draft customer invoice, making double billing impossible even if two
 * conversion requests race.
 */
export async function convertPrebill(orgId: string, actorId: string, id: string) {
  const existing = (await db.execute(sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id, project.subsidiary_id,
           invoice.document_number as invoice_number
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
  `)) as unknown as { rows: { status: PrebillStatus; invoice_id: string | null; invoice_number: string | null; subsidiary_id: string | null }[] }
  const observed = existing.rows[0]
  if (!observed) throw new WipBillingError('Prebill not found', 404)
  if (observed.status === 'converted' && observed.invoice_id) {
    return { id: observed.invoice_id, documentNumber: observed.invoice_number!, idempotent: true }
  }
  if (observed.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
  return db.transaction(async (tx) => {
    const header = (await tx.execute(sql`
      select worksheet.*, project.customer_id, project.customer_po_number, project.subsidiary_id,
             project.name as project_name, type.billing_method,
             coalesce(subsidiary.base_currency, org.base_currency) as currency
        from wip_prebills worksheet
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
        join orgs org on org.id = worksheet.org_id
        left join subsidiaries subsidiary on subsidiary.org_id = project.org_id and subsidiary.id = project.subsidiary_id
        left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
       where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       for update of worksheet
    `)) as unknown as { rows: Record<string, any>[] }
    const worksheet = header.rows[0]
    if (!worksheet) throw new WipBillingError('Prebill not found', 404)
    if (worksheet.status === 'converted' && worksheet.invoice_document_id) {
      const invoice = (await tx.execute(sql`
        select document_number from documents where org_id = ${orgId} and id = ${worksheet.invoice_document_id}
      `)) as unknown as { rows: { document_number: string }[] }
      return { id: worksheet.invoice_document_id, documentNumber: invoice.rows[0]!.document_number, idempotent: true }
    }
    if (worksheet.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
    if (!worksheet.customer_id) throw new WipBillingError('The project has no customer to invoice')
    if (!worksheet.currency) throw new WipBillingError('The project subsidiary has no functional currency')
    const invoiceNumber = await nextDocumentNumber(orgId, 'customer_invoice', 'INV-', worksheet.subsidiary_id)

    const lines = (await tx.execute(sql`
      select line.*,
             exists (
               select 1 from wip_holds hold
                where hold.org_id = line.org_id and hold.source_type = line.source_type
                  and hold.source_id = coalesce(line.time_entry_id, line.document_line_id)
                  and hold.released_at is null
             ) as actively_held
        from wip_prebill_lines line
       where line.org_id = ${orgId} and line.prebill_id = ${id} and line.disposition = 'bill'
       order by line.line_number
       for update
    `)) as unknown as { rows: Record<string, any>[] }
    if (lines.rows.length === 0) throw new WipBillingError('The prebill has no billable lines')
    if (lines.rows.some((line) => line.actively_held)) throw new WipBillingError('Release all billing holds before conversion')

    const defaultIncome = (await tx.execute(sql`
      select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
       order by number nulls last limit 1
    `)) as unknown as { rows: { id: string }[] }
    const fallbackIncomeAccountId = defaultIncome.rows[0]?.id
    if (!fallbackIncomeAccountId && lines.rows.some((line) => !line.income_account_id)) {
      throw new WipBillingError('Configure an income account before converting this prebill')
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-request-number:${orgId}`}, 0))`)
    const requestNumberResult = (await tx.execute(sql`
      select coalesce(max((regexp_replace(request_number, '\\D', '', 'g'))::bigint), 0) as n
        from billing_requests where org_id = ${orgId} and request_number ~ '^BREQ-[0-9]+$'
    `)) as unknown as { rows: { n: string }[] }
    const requestNumber = `BREQ-${String(Number(requestNumberResult.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`
    const timeIds = lines.rows.filter((line) => line.time_entry_id).map((line) => line.time_entry_id)
    const sourceCostLineIds = lines.rows.filter((line) => line.document_line_id).map((line) => line.document_line_id)
    const requestResult = (await tx.execute(sql`
      insert into billing_requests (
        org_id, project_id, request_number, invoice_type, basis, cutoff_date,
        invoice_description, customer_po, billing_method_snapshot, selected_time_entry_ids,
        notes, status, custom, created_by, updated_by
      ) values (
        ${orgId}, ${worksheet.project_id}, ${requestNumber}, 'progress', 'time_selection',
        ${worksheet.period_end}, ${`Prebill ${worksheet.worksheet_number}`}, ${worksheet.customer_po_number},
        ${worksheet.billing_method ?? 'time_and_materials'}, ${JSON.stringify(timeIds)}::jsonb,
        ${worksheet.notes}, 'open',
        ${JSON.stringify({ prebillId: id, selectedCostLineIds: sourceCostLineIds })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id
    `)) as unknown as { rows: { id: string }[] }
    const billingRequestId = requestResult.rows[0]!.id

    const invoiceResult = (await tx.execute(sql`
      insert into documents (
        org_id, kind, document_number, party_id, document_date, currency, status,
        project_id, subsidiary_id, billing_method, is_final_invoice, reference_number,
        memo, subtotal, tax_total, total, custom, created_by, updated_by
      ) values (
        ${orgId}, 'customer_invoice', ${invoiceNumber}, ${worksheet.customer_id}, ${worksheet.period_end},
        ${worksheet.currency}, 'draft', ${worksheet.project_id}, ${worksheet.subsidiary_id},
        ${worksheet.billing_method === 'fixed_price' ? 'fixed_price' : 'time_and_materials'}, false,
        ${worksheet.customer_po_number}, ${`Created from ${worksheet.worksheet_number}`},
        '0', '0', '0', ${JSON.stringify({ prebillId: id, billingRequestId })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id
    `)) as unknown as { rows: { id: string }[] }
    const invoiceId = invoiceResult.rows[0]!.id
    const billedAmounts: string[] = []
    const billedTaxes: string[] = []

    for (const [index, line] of lines.rows.entries()) {
      const inputAmount = roundMoney(String(line.proposed_bill_amount), 2)
      const taxConfig = line.tax_code_id
        ? await loadTaxComponentConfig(orgId, line.tax_code_id, worksheet.period_end, tx)
        : []
      if (line.tax_code_id && taxConfig.length === 0) {
        throw new WipBillingError(`Tax code on line ${line.line_number} is inactive or has no effective rate`)
      }
      const calculated = computeLineTaxes(inputAmount, taxConfig)
      const amount = calculated.netAmount
      const taxAmount = calculated.taxTotal
      const accountId = line.income_account_id ?? fallbackIncomeAccountId
      const invoiceLineResult = (await tx.execute(sql`
        insert into document_lines (
          org_id, document_id, line_number, item_id, account_id, description,
          quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
          employee_id, time_entry_id, time_type_id, is_billable, bill_rate, bill_amount,
          custom, created_by, updated_by
        ) values (
          ${orgId}, ${invoiceId}, ${index + 1}, ${line.item_id}, ${accountId}, ${line.description},
          ${line.quantity}, ${line.unit},
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount}, ${line.tax_code_id}, ${taxAmount}, ${line.department_id}, ${worksheet.project_id},
          ${line.employee_party_id}, ${line.time_entry_id}, ${line.time_type_id}, true,
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount},
          ${JSON.stringify({ prebillLineId: line.id, originalBillAmount: line.original_bill_amount, adjustmentAmount: line.adjustment_amount })}::jsonb,
          ${actorId}, ${actorId}
        ) returning id
      `)) as unknown as { rows: { id: string }[] }
      const invoiceLineId = invoiceLineResult.rows[0]!.id
      await persistLineTaxComponents(orgId, invoiceLineId, calculated.components, actorId, tx)
      if (line.source_type === 'time_entry') {
        const stamped = (await tx.execute(sql`
          update time_entries set invoiced_by_line_id = ${invoiceLineId}, billing_status = 'billed', updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.time_entry_id}
             and status = 'approved' and is_billable and billing_status = 'unbilled'
           returning id
        `)) as unknown as { rows: { id: string }[] }
        if (!stamped.rows[0]) throw new WipBillingError(`Time source on line ${line.line_number} is no longer available`)
      } else {
        const stamped = (await tx.execute(sql`
          update document_lines set billed_by_line_id = ${invoiceLineId}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.document_line_id} and billed_by_line_id is null
           returning id
        `)) as unknown as { rows: { id: string }[] }
        if (!stamped.rows[0]) throw new WipBillingError(`Cost source on line ${line.line_number} is no longer available`)
      }
      billedAmounts.push(amount)
      billedTaxes.push(taxAmount)
    }

    const subtotal = sum(billedAmounts)
    const taxTotal = sum(billedTaxes)
    const total = add(subtotal, taxTotal)
    await tx.execute(sql`
      update documents set subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${total}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${invoiceId}
    `)
    await tx.execute(sql`
      update billing_requests set status = 'invoiced', invoice_document_id = ${invoiceId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${billingRequestId}
    `)
    await tx.execute(sql`
      update wip_prebills
         set status = 'converted', billing_request_id = ${billingRequestId}, invoice_document_id = ${invoiceId},
             converted_at = now(), converted_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `)
    await appendEvent(tx, orgId, id, actorId, 'converted', { billingRequestId, invoiceId, invoiceNumber, subtotal })
    await audit(tx, orgId, 'wip_prebills', id, actorId, {
      before: { status: 'approved' },
      after: { status: 'converted', billingRequestId, invoiceDocumentId: invoiceId },
    })
    return { id: invoiceId, documentNumber: invoiceNumber, billingRequestId, idempotent: false }
  })
}

export interface WipAnalytics {
  aging: { current: string; days1to30: string; days31to60: string; days61to90: string; over90: string; held: string }
  realization: { original: string; billed: string; adjustment: string; percent: number | null }
  leakage: { writeDowns: string; heldOver90: string; total: string }
}

export async function wipAnalytics(orgId: string, asOf = new Date().toISOString().slice(0, 10)): Promise<WipAnalytics> {
  requireDate(asOf, 'As-of date')
  const [agingResult, realizationResult, leakageResult] = await Promise.all([
    db.execute(sql`
      with available as (
        select te.worked_on as source_date, round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4) as amount,
               exists(select 1 from wip_holds h where h.org_id=te.org_id and h.source_type='time_entry' and h.source_id=te.id and h.released_at is null) as held
          from time_entries te left join items item on item.org_id=te.org_id and item.id=te.item_id
         where te.org_id=${orgId} and te.status='approved' and te.is_billable and te.billing_status='unbilled'
        union all
        select doc.document_date,
               case when doc.kind='project_charge' then coalesce(line.bill_amount,0)
                    when line.markup_percent is not null then round(line.amount*(1+line.markup_percent/100),4)
                    else round(line.amount*coalesce(nullif(line.cost_multiplier,0),1),4) end,
               exists(select 1 from wip_holds h where h.org_id=line.org_id and h.source_type='document_line' and h.source_id=line.id and h.released_at is null)
          from document_lines line join documents doc on doc.org_id=line.org_id and doc.id=line.document_id
         where line.org_id=${orgId} and line.is_billable and line.billed_by_line_id is null
           and ((doc.kind='project_charge' and doc.status in ('approved','posted'))
             or (doc.status='posted' and doc.kind in ('vendor_bill','expense_report','card_charge','check')))
      )
      select coalesce(sum(amount) filter (where ${asOf}::date-source_date <= 0 and not held),0)::text as current,
             coalesce(sum(amount) filter (where ${asOf}::date-source_date between 1 and 30 and not held),0)::text as "days1to30",
             coalesce(sum(amount) filter (where ${asOf}::date-source_date between 31 and 60 and not held),0)::text as "days31to60",
             coalesce(sum(amount) filter (where ${asOf}::date-source_date between 61 and 90 and not held),0)::text as "days61to90",
             coalesce(sum(amount) filter (where ${asOf}::date-source_date > 90 and not held),0)::text as "over90",
             coalesce(sum(amount) filter (where held),0)::text as held
        from available
    `),
    db.execute(sql`
      select coalesce(sum(original_bill_amount),0)::text as original,
             coalesce(sum(proposed_bill_amount),0)::text as billed,
             coalesce(sum(adjustment_amount),0)::text as adjustment
        from wip_prebills where org_id=${orgId} and status='converted'
    `),
    db.execute(sql`
      select coalesce(sum(-line.adjustment_amount) filter (where line.adjustment_amount < 0),0)::text as write_downs
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id=line.org_id and worksheet.id=line.prebill_id
       where line.org_id=${orgId} and worksheet.status in ('approved','converted')
    `),
  ]) as unknown as [{ rows: WipAnalytics['aging'][] }, { rows: { original: string; billed: string; adjustment: string }[] }, { rows: { write_downs: string }[] }]
  const aging = agingResult.rows[0] ?? { current: '0', days1to30: '0', days31to60: '0', days61to90: '0', over90: '0', held: '0' }
  const realization = realizationResult.rows[0] ?? { original: '0', billed: '0', adjustment: '0' }
  const original = Number(realization.original)
  const percent = original === 0 ? null : Number(realization.billed) / original
  const heldOver90Result = (await db.execute(sql`
    select coalesce(sum(case when hold.source_type='time_entry' then te.hours*coalesce(te.bill_rate,item.default_rate,0)
                             else case when doc.kind='project_charge' then coalesce(line.bill_amount,0)
                                       when line.markup_percent is not null then line.amount*(1+line.markup_percent/100)
                                       else line.amount*coalesce(nullif(line.cost_multiplier,0),1) end end),0)::text as amount
      from wip_holds hold
      left join time_entries te on hold.source_type='time_entry' and te.org_id=hold.org_id and te.id=hold.source_id
      left join items item on item.org_id=te.org_id and item.id=te.item_id
      left join document_lines line on hold.source_type='document_line' and line.org_id=hold.org_id and line.id=hold.source_id
      left join documents doc on doc.org_id=line.org_id and doc.id=line.document_id
     where hold.org_id=${orgId} and hold.released_at is null
       and ${asOf}::date - coalesce(te.worked_on, doc.document_date) > 90
  `)) as unknown as { rows: { amount: string }[] }
  const writeDowns = leakageResult.rows[0]?.write_downs ?? '0'
  const heldOver90 = heldOver90Result.rows[0]?.amount ?? '0'
  return {
    aging,
    realization: { ...realization, percent },
    leakage: { writeDowns, heldOver90, total: add(writeDowns, heldOver90) },
  }
}

export async function listWipProjects(orgId: string) {
  const result = (await db.execute(sql`
    select project.id, project.name, customer.display_name as "customerName"
      from projects project
      left join parties customer on customer.org_id=project.org_id and customer.id=project.customer_id
     where project.org_id=${orgId} and project.status not in ('closed','cancelled')
     order by project.name
  `)) as unknown as { rows: { id: string; name: string; customerName: string | null }[] }
  return result.rows
}
