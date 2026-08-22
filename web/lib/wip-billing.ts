import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { add, cmp, mul, mulPercent, normalizeMoney, roundMoney, sum } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal } from './exact-decimal'
import { computeLineTaxes } from '@openbooks/engine/src/tax.ts'
import {
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from '@openbooks/engine/src/tax-persist.ts'
import { nextDocumentNumber } from './bills'
import { isFeatureEnabled } from './features'
import type { FinancialProfile, InvoicingProfile } from '@openbooks/schema'
import {
  capWipSources,
  effectiveWipPolicy,
  priceWipSource,
  sourceLinePrebillingReason,
  type WipPolicyVersion,
} from './wip-billing-policy'

export type WipSourceType = 'time_entry' | 'document_line'
export type PrebillStatus = 'draft' | 'review' | 'approved' | 'converted' | 'void'

export class WipBillingError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'WipBillingError'
  }
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function persistMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new WipBillingError(`${label} must be an exact decimal`)
  try {
    return normalizeMoney(exact)
  } catch {
    throw new WipBillingError(`${label} must be an exact decimal`)
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

export type PrebillListRow = {
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
};

export type PrebillLineRow = {
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
  pricingSnapshot: Record<string, unknown>
};

export interface WipProjectOption {
  id: string
  name: string
  customerName: string | null
  projectTypeName: string
  lineBuilder: string
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
type Executor = Pick<Tx, 'execute'>

type ProjectPolicyContext = {
  projectId: string
  projectTypeId: string
  projectTypeKey: string
  projectTypeName: string
  billingMethod: string | null
  contractValue: string
  markupPercent: string
  fallbackProfile: FinancialProfile
  invoicingProfile: InvoicingProfile
  versions: WipPolicyVersion[]
}

type RawWipSource = {
  source_type: WipSourceType
  source_id: string
  time_entry_id: string | null
  document_line_id: string | null
  source_document_id: string | null
  source_date: string
  description: string | null
  quantity: string
  unit: string | null
  item_id: string | null
  income_account_id: string | null
  tax_code_id: string | null
  employee_party_id: string | null
  time_type_id: string | null
  department_id: string | null
  costing_basis: string | null
  document_kind: string | null
  document_status: string | null
  direct_cost_amount: string
  native_bill_amount: string
}

type OverheadRateRow = {
  department_id: string | null
  rate_kind: 'per_hour' | 'percent'
  rate: string
  effective_from: string
  effective_to: string | null
}

async function loadProjectPolicy(
  executor: Executor,
  orgId: string,
  projectId: string,
  lock = false,
): Promise<ProjectPolicyContext> {
  const project = (await executor.execute<{
    id: string
    project_type_id: string | null
    contract_value: string
    markup_percent: string
    key: string | null
    name: string | null
    billing_method: string | null
    financial_profile: FinancialProfile | null
    invoicing_profile: InvoicingProfile | null
  }>(sql`
    select project.id, project.project_type_id, coalesce(project.contract_value, 0)::text as contract_value,
           coalesce((project.custom->>'markupPercent')::numeric, 0)::text as markup_percent,
           type.key, type.name, type.billing_method, type.financial_profile, type.invoicing_profile
      from projects project
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
     where project.org_id = ${orgId} and project.id = ${projectId}
       and project.status not in ('closed', 'cancelled')
     ${lock ? sql`for update of project` : sql``}
  `))
  const row = project.rows[0]
  if (!row) throw new WipBillingError('Project not found or is no longer active', 404)
  if (!row.project_type_id || !row.financial_profile || !row.invoicing_profile) {
    throw new WipBillingError('Assign an active project type before creating a prebill')
  }
  const versions = (await executor.execute<WipPolicyVersion>(sql`
    select id, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           financial_profile as "financialProfile"
      from project_financial_profile_versions
     where org_id = ${orgId} and project_type_id = ${row.project_type_id}
     order by effective_from desc
  `))
  return {
    projectId: row.id,
    projectTypeId: row.project_type_id,
    projectTypeKey: row.key ?? 'project',
    projectTypeName: row.name ?? 'Project',
    billingMethod: row.billing_method,
    contractValue: normalizeMoney(row.contract_value),
    markupPercent: normalizeMoney(row.markup_percent),
    fallbackProfile: row.financial_profile,
    invoicingProfile: row.invoicing_profile,
    versions: versions.rows,
  }
}

function textList(values: string[]): string {
  return `{${values.map((value) => value.replaceAll('"', '')).join(',')}}`
}

async function remainingContractCapacity(
  executor: Executor,
  orgId: string,
  policy: ProjectPolicyContext,
  asOf: string,
  excludePrebillId?: string,
): Promise<string | null> {
  const profile = effectiveWipPolicy(policy.versions, policy.fallbackProfile, asOf).financialProfile
  if (profile.totalPrice.method !== 'not_to_exceed') return null
  const invoiceKinds = profile.invoicedToDate.docKinds.length ? profile.invoicedToDate.docKinds : ['customer_invoice']
  const creditKinds = profile.invoicedToDate.creditKinds.length ? profile.invoicedToDate.creditKinds : ['customer_credit']
  const allKinds = [...new Set([...invoiceKinds, ...creditKinds])]
  const used = (await executor.execute<{ used: string }>(sql`
    select coalesce((
             select sum(case when document.kind = any(${textList(creditKinds)}::text[])
                             then -line.amount else line.amount end)
               from document_lines line
               join documents document on document.org_id = line.org_id and document.id = line.document_id
              where line.org_id = ${orgId}
                and coalesce(line.project_id, document.project_id) = ${policy.projectId}
                and document.status = 'posted'
                and document.kind = any(${textList(allKinds)}::text[])
           ), 0)
           + coalesce((
             select sum(worksheet.proposed_bill_amount)
               from wip_prebills worksheet
              where worksheet.org_id = ${orgId} and worksheet.project_id = ${policy.projectId}
                and worksheet.status in ('draft', 'review', 'approved')
                and (${excludePrebillId ?? null}::uuid is null or worksheet.id <> ${excludePrebillId ?? null})
           ), 0) as used
  `))
  const remaining = add(policy.contractValue, `-${normalizeMoney(used.rows[0]?.used ?? '0')}`)
  return cmp(remaining, '0') > 0 ? remaining : '0.0000'
}

function rateEngineOverhead(
  source: RawWipSource,
  profile: FinancialProfile,
  rates: OverheadRateRow[],
): string {
  if (source.source_type !== 'time_entry' || profile.overhead.method !== 'rate_engine') return '0.0000'
  const basis = profile.overhead.rateEngine?.hoursBasis ?? 'total_hours'
  if (basis === 'actual_hours' && source.costing_basis !== 'actual') return '0.0000'
  const effective = rates.filter((rate) => (
    rate.effective_from <= source.source_date
      && (rate.effective_to == null || rate.effective_to >= source.source_date)
      && (rate.department_id == null || rate.department_id === source.department_id)
  ))
  const hasSpecific = effective.some((rate) => rate.department_id === source.department_id && source.department_id != null)
  return sum(effective
    .filter((rate) => !hasSpecific || rate.department_id === source.department_id)
    .map((rate) => rate.rate_kind === 'percent'
      ? mulPercent(source.direct_cost_amount, rate.rate)
      : mul(source.quantity, rate.rate)))
}

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
    values (${orgId}, ${prebillId}, ${eventType}, ${actorId}, ${JSON.stringify(details)}::jsonb)
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
    const policy = await loadProjectPolicy(tx, orgId, input.projectId, true)
    const procedureReason = sourceLinePrebillingReason(policy.invoicingProfile)
    if (procedureReason) throw new WipBillingError(procedureReason)
    const cutoffPolicy = effectiveWipPolicy(policy.versions, policy.fallbackProfile, periodEnd)
    const remainingCap = await remainingContractCapacity(tx, orgId, policy, periodEnd)
    if (remainingCap != null && cmp(remainingCap, '0') <= 0) {
      throw new WipBillingError('The project has reached its not-to-exceed contract cap')
    }

    const numberRow = (await tx.execute<{ n: string }>(sql`
      select coalesce(max((regexp_replace(worksheet_number, '\\D', '', 'g'))::bigint), 0) as n
        from wip_prebills
       where org_id = ${orgId} and worksheet_number ~ '^WIP-[0-9]+$'
    `))
    const worksheetNumber = `WIP-${String(Number(numberRow.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`
    const candidates = (await tx.execute<RawWipSource>(sql`
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
               te.costing_basis,
               null::text as document_kind,
               null::text as document_status,
               round(te.hours * coalesce(te.cost_rate, 0), 4)::text as direct_cost_amount,
               round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4)::text as native_bill_amount
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
               null::text as costing_basis,
               doc.kind as document_kind,
               doc.status as document_status,
               (case
                 when doc.kind = 'project_charge' then coalesce(line.cost_amount, line.amount)
                 when doc.kind in ('vendor_credit', 'card_refund') then -line.amount
                 else line.amount
               end)::text as direct_cost_amount,
               case
                 when doc.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                 when line.bill_amount is not null then case when doc.kind in ('vendor_credit', 'card_refund') then -line.bill_amount else line.bill_amount end
                 when line.markup_percent is not null then round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * (1 + line.markup_percent / 100), 4)
                 else round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * coalesce(nullif(line.cost_multiplier, 0), 1), 4)
               end::text as native_bill_amount
          from document_lines line
          join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
          left join items item on item.org_id = line.org_id and item.id = line.item_id
         where line.org_id = ${orgId}
           and coalesce(line.project_id, doc.project_id) = ${input.projectId}
           and line.is_billable
           and line.billed_by_line_id is null
           and doc.document_date <= ${periodEnd}
           and (${periodStart}::date is null or doc.document_date >= ${periodStart})
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
    `))

    const overheadRates = (await tx.execute<OverheadRateRow>(sql`
      select department_id, rate_kind, rate_percent::text as rate,
             effective_from::text as effective_from, effective_to::text as effective_to
        from overhead_rates
       where org_id = ${orgId}
         and effective_from <= ${periodEnd}
         and (effective_to is null or ${periodStart ?? periodEnd}::date <= effective_to)
       order by effective_from, department_id nulls first, id
    `))

    const priced = candidates.rows.flatMap((source) => {
      const version = effectiveWipPolicy(policy.versions, policy.fallbackProfile, source.source_date)
      const calculated = priceWipSource(version.financialProfile, {
        sourceType: source.source_type,
        sourceDate: source.source_date,
        documentKind: source.document_kind,
        documentStatus: source.document_status,
        directCostAmount: source.direct_cost_amount,
        nativeBillAmount: source.native_bill_amount,
        quantity: source.quantity,
        costingBasis: source.costing_basis,
        rateEngineOverhead: rateEngineOverhead(source, version.financialProfile, overheadRates.rows),
      }, policy.markupPercent)
      return calculated.eligible ? [{ ...source, ...calculated, policyVersion: version }] : []
    })
    const billable = capWipSources(priced, remainingCap)
    if (billable.length === 0) throw new WipBillingError('No eligible unbilled work matches this project type and cutoff')

    const policySnapshot = {
      projectTypeId: policy.projectTypeId,
      projectTypeKey: policy.projectTypeKey,
      projectTypeName: policy.projectTypeName,
      billingProcedure: policy.invoicingProfile.billingProcedure ?? 'standard',
      lineBuilder: policy.invoicingProfile.lineBuilder,
      billingBasis: policy.invoicingProfile.allowedBases.includes('time_selection') ? 'time_selection' : 'date_range',
      cutoffProfileVersionId: cutoffPolicy.id,
      cutoffProfileEffectiveFrom: cutoffPolicy.effectiveFrom,
      totalPriceMethod: cutoffPolicy.financialProfile.totalPrice.method,
      contractCap: remainingCap == null ? null : policy.contractValue,
      remainingCapAtCreation: remainingCap,
    }
    const created = (await tx.execute<{ id: string; worksheetNumber: string }>(sql`
      insert into wip_prebills (
        org_id, project_id, worksheet_number, period_start, period_end, notes,
        status, custom, created_by, updated_by
      ) values (
        ${orgId}, ${input.projectId}, ${worksheetNumber}, ${periodStart}, ${periodEnd},
        ${input.notes?.trim() || null}, 'draft', ${JSON.stringify({ policy: policySnapshot })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id, worksheet_number as "worksheetNumber"
    `))
    const prebill = created.rows[0]!

    let lineNumber = 1
    for (const source of billable) {
      const pricingSnapshot = {
        projectFinancialProfileVersionId: source.policyVersion.id,
        projectFinancialProfileEffectiveFrom: source.policyVersion.effectiveFrom,
        pricingMode: source.pricingMode,
        markupPercent: source.markupPercent,
        nativeBillAmount: source.native_bill_amount,
        uncappedBillAmount: source.billAmount,
        directCostAmount: source.directCostAmount,
        overheadAmount: source.overheadAmount,
      }
      await tx.execute(sql`
        insert into wip_prebill_lines (
          org_id, prebill_id, project_id, line_number, source_type, time_entry_id,
          document_line_id, source_document_id, source_date, description, quantity, unit,
          item_id, income_account_id, tax_code_id, employee_party_id, time_type_id,
          department_id, cost_amount, original_bill_amount, proposed_bill_amount,
          adjustment_amount, pricing_snapshot, disposition, created_by, updated_by
        ) values (
          ${orgId}, ${prebill.id}, ${input.projectId}, ${lineNumber++}, ${source.source_type},
          ${source.time_entry_id}, ${source.document_line_id}, ${source.source_document_id},
          ${source.source_date}, ${source.description}, ${source.quantity}, ${source.unit},
          ${source.item_id}, ${source.income_account_id}, ${source.tax_code_id},
          ${source.employee_party_id}, ${source.time_type_id}, ${source.department_id},
          ${source.loadedCostAmount}, ${source.cappedBillAmount}, ${source.cappedBillAmount}, '0',
          ${JSON.stringify(pricingSnapshot)}::jsonb, 'bill',
          ${actorId}, ${actorId}
        )
      `)
    }
    await refreshTotals(tx, orgId, prebill.id, actorId)
    await appendEvent(tx, orgId, prebill.id, actorId, 'created', { sourceCount: billable.length, periodStart, periodEnd, policy: policySnapshot })
    await audit(tx, orgId, 'wip_prebills', prebill.id, actorId, { after: { worksheetNumber, status: 'draft', policy: policySnapshot } })
    return { ...prebill, sourceCount: billable.length }
  })
}

export async function listPrebills(orgId: string, projectId?: string): Promise<PrebillListRow[]> {
  const result = (await db.execute<PrebillListRow>(sql`
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
  `))
  return result.rows
}

export async function loadPrebill(orgId: string, id: string): Promise<PrebillDetail | null> {
  const headers = await listPrebills(orgId)
  const header = headers.find((row) => row.id === id)
  if (!header) return null
  const [lineResult, eventResult, detailResult] = await Promise.all([
    db.execute<PrebillLineRow>(sql`
      select line.id, line.line_number as "lineNumber", line.source_type as "sourceType",
             line.time_entry_id as "timeEntryId", line.document_line_id as "documentLineId",
             line.source_document_id as "sourceDocumentId", line.source_date::text as "sourceDate",
             line.description, line.quantity::text, line.unit, line.cost_amount::text as "costAmount",
             line.original_bill_amount::text as "originalBillAmount",
             line.proposed_bill_amount::text as "proposedBillAmount",
             line.adjustment_amount::text as "adjustmentAmount",
             line.adjustment_reason as "adjustmentReason",
             line.adjustment_evidence as "adjustmentEvidence",
             line.pricing_snapshot as "pricingSnapshot", line.disposition,
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
    db.execute<(PrebillDetail['events'])[number]>(sql`
      select event.id, event.event_type as "eventType", coalesce(actor.name, actor.email) as "actorName",
             event.occurred_at as "occurredAt", event.details
        from wip_prebill_events event
        left join users actor on actor.id = event.actor_id
       where event.org_id = ${orgId} and event.prebill_id = ${id}
       order by event.occurred_at, event.id
    `),
    db.execute<Pick<PrebillDetail, 'notes' | 'submittedAt' | 'approvedAt' | 'convertedAt' | 'voidedAt' | 'voidReason'>>(sql`
      select notes, submitted_at as "submittedAt", approved_at as "approvedAt",
             converted_at as "convertedAt", voided_at as "voidedAt", void_reason as "voidReason"
        from wip_prebills where org_id = ${orgId} and id = ${id}
    `),
  ])
  return { ...header, ...detailResult.rows[0]!, lines: lineResult.rows, events: eventResult.rows }
}

export async function updatePrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  input: UpdatePrebillLineInput,
) {
  const proposed = persistMoney(input.proposedBillAmount, 'Proposed bill amount')
  const evidence = evidenceList(input.adjustmentEvidence)
  return db.transaction(async (tx) => {
    const current = (await tx.execute<{ proposed: string; original: string; status: PrebillStatus; project_id: string; period_end: string; custom: { policy?: { totalPriceMethod?: string } }; other_proposed: string }>(sql`
      select line.proposed_bill_amount::text as proposed, line.original_bill_amount::text as original,
             worksheet.status, worksheet.project_id, worksheet.period_end::text as period_end,
             worksheet.custom,
             coalesce((select sum(other.proposed_bill_amount) from wip_prebill_lines other
                        where other.org_id = line.org_id and other.prebill_id = line.prebill_id
                          and other.id <> line.id and other.disposition = 'bill'), 0)::text as other_proposed
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
       for update
    `))
    const before = current.rows[0]
    if (!before) throw new WipBillingError('Prebill line not found', 404)
    if (before.status !== 'draft') throw new WipBillingError('Only a draft prebill can be edited')
    if ((cmp(before.original, '0') >= 0 && cmp(proposed, '0') < 0) || (cmp(before.original, '0') < 0 && cmp(proposed, '0') > 0)) {
      throw new WipBillingError('A billing adjustment cannot reverse the source line sign')
    }
    const changed = cmp(proposed, before.original) !== 0
    const reason = input.adjustmentReason?.trim() || null
    if (changed && !reason) throw new WipBillingError('A reason is required for a write-up or write-down')
    if (changed && evidence.length === 0) throw new WipBillingError('Evidence is required for a write-up or write-down')
    if (before.custom?.policy?.totalPriceMethod === 'not_to_exceed') {
      const policy = await loadProjectPolicy(tx, orgId, before.project_id)
      const capacity = await remainingContractCapacity(tx, orgId, policy, before.period_end, prebillId)
      if (capacity != null && cmp(add(before.other_proposed, proposed), capacity) > 0) {
        throw new WipBillingError(`Proposed billing exceeds the remaining not-to-exceed capacity of ${capacity}`)
      }
    }
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
    const row = (await tx.execute<{ source_type: WipSourceType; source_id: string; project_id: string; status: PrebillStatus }>(sql`
      select line.source_type, coalesce(line.time_entry_id, line.document_line_id) as source_id,
             line.project_id, worksheet.status
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
       for update
    `))
    const source = row.rows[0]
    if (!source) throw new WipBillingError('Prebill line not found', 404)
    if (source.status !== 'draft') throw new WipBillingError('Only a draft prebill can be changed')
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from wip_holds
       where org_id = ${orgId} and source_type = ${source.source_type}
         and source_id = ${source.source_id} and released_at is null
       for update
    `))
    let holdId = existing.rows[0]?.id
    if (!holdId) {
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into wip_holds (
          org_id, project_id, source_type, source_id, reason, evidence, held_by,
          created_by, updated_by
        ) values (
          ${orgId}, ${source.project_id}, ${source.source_type}, ${source.source_id},
          ${cleanReason}, ${JSON.stringify(cleanEvidence)}::jsonb, ${actorId}, ${actorId}, ${actorId}
        ) returning id
      `))
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
    const released = (await tx.execute<{ source_type: WipSourceType; source_id: string }>(sql`
      update wip_holds
         set released_at = now(), released_by = ${actorId}, release_reason = ${releaseReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${holdId} and released_at is null
       returning source_type, source_id
    `))
    const source = released.rows[0]
    if (!source) throw new WipBillingError('Active hold not found', 404)
    const prebillRows = (await tx.execute<{ prebill_id: string }>(sql`
      update wip_prebill_lines line
         set disposition = 'bill', updated_at = now(), updated_by = ${actorId}
        from wip_prebills worksheet
       where line.org_id = ${orgId}
         and worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
         and worksheet.status = 'draft'
         and line.source_type = ${source.source_type}
         and coalesce(line.time_entry_id, line.document_line_id) = ${source.source_id}
       returning line.prebill_id
    `))
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
    const locked = (await tx.execute<{ status: PrebillStatus; submitted_by: string | null; created_by: string | null; project_id: string; period_end: string; custom: { policy?: { totalPriceMethod?: string } } }>(sql`
      select status, submitted_by, created_by, project_id, period_end::text as period_end, custom
        from wip_prebills
       where org_id = ${orgId} and id = ${id}
       for update
    `))
    const header = locked.rows[0]
    if (!header) throw new WipBillingError('Prebill not found', 404)
    const current = (await tx.execute<{ bill_lines: number; proposed_total: string; unsupported_adjustments: number }>(sql`
      select count(*) filter (where disposition = 'bill')::int as bill_lines,
             coalesce(sum(proposed_bill_amount) filter (where disposition = 'bill'), 0)::text as proposed_total,
             count(*) filter (
               where disposition = 'bill'
                 and proposed_bill_amount <> original_bill_amount
                 and (nullif(trim(adjustment_reason), '') is null
                   or jsonb_array_length(adjustment_evidence) = 0)
             )::int as unsupported_adjustments
        from wip_prebill_lines
       where org_id = ${orgId} and prebill_id = ${id}
    `))
    const worksheet = { ...header, ...current.rows[0]! }
    if (!rule.from.includes(worksheet.status)) throw new WipBillingError(`Cannot ${action} a ${worksheet.status} prebill`)
    if (action === 'approve' && (header.submitted_by ?? header.created_by) === actorId) {
      throw new WipBillingError('The submitter cannot approve this prebill')
    }
    if (action === 'submit' && worksheet.bill_lines === 0) throw new WipBillingError('A prebill must contain at least one billable line')
    if ((action === 'submit' || action === 'approve') && worksheet.unsupported_adjustments > 0) {
      throw new WipBillingError('Every write-up and write-down requires a reason and evidence')
    }
    if ((action === 'submit' || action === 'approve') && header.custom?.policy?.totalPriceMethod === 'not_to_exceed') {
      const policy = await loadProjectPolicy(tx, orgId, header.project_id)
      const capacity = await remainingContractCapacity(tx, orgId, policy, header.period_end, id)
      if (capacity != null && cmp(worksheet.proposed_total, capacity) > 0) {
        throw new WipBillingError(`Prebill exceeds the remaining not-to-exceed capacity of ${capacity}`)
      }
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
  const existing = (await db.execute<{ status: PrebillStatus; invoice_id: string | null; invoice_number: string | null; subsidiary_id: string | null }>(sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id, project.subsidiary_id,
           invoice.document_number as invoice_number
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
  `))
  const observed = existing.rows[0]
  if (!observed) throw new WipBillingError('Prebill not found', 404)
  if (observed.status === 'converted' && observed.invoice_id) {
    return { id: observed.invoice_id, documentNumber: observed.invoice_number!, idempotent: true }
  }
  if (observed.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
  return db.transaction(async (tx) => {
    const header = (await tx.execute<Record<string, any>>(sql`
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
    `))
    const worksheet = header.rows[0]
    if (!worksheet) throw new WipBillingError('Prebill not found', 404)
    if (worksheet.status === 'converted' && worksheet.invoice_document_id) {
      const invoice = (await tx.execute<{ document_number: string }>(sql`
        select document_number from documents where org_id = ${orgId} and id = ${worksheet.invoice_document_id}
      `))
      return { id: worksheet.invoice_document_id, documentNumber: invoice.rows[0]!.document_number, idempotent: true }
    }
    if (worksheet.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
    if (!worksheet.customer_id) throw new WipBillingError('The project has no customer to invoice')
    if (!worksheet.currency) throw new WipBillingError('The project subsidiary has no functional currency')
    const policySnapshot = worksheet.custom?.policy as {
      billingProcedure?: string
      lineBuilder?: string
      billingBasis?: string
      totalPriceMethod?: string
    } | undefined
    if (!policySnapshot || policySnapshot.billingProcedure !== 'standard' || !['tm_actual', 'cost_plus'].includes(policySnapshot.lineBuilder ?? '')) {
      throw new WipBillingError('This worksheet does not contain an eligible source-line billing policy snapshot')
    }
    if (policySnapshot.totalPriceMethod === 'not_to_exceed') {
      const policy = await loadProjectPolicy(tx, orgId, worksheet.project_id)
      const capacity = await remainingContractCapacity(tx, orgId, policy, worksheet.period_end, id)
      if (cmp(String(worksheet.proposed_bill_amount), capacity ?? '0') > 0) {
        throw new WipBillingError(`Prebill exceeds the remaining not-to-exceed capacity of ${capacity ?? '0.0000'}`)
      }
    }

    const lines = (await tx.execute<Record<string, any>>(sql`
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
    `))
    if (lines.rows.length === 0) throw new WipBillingError('The prebill has no billable lines')
    if (lines.rows.some((line) => line.actively_held)) throw new WipBillingError('Release all billing holds before conversion')
    // Stored prebill lines and existing invoices stay. Turning Inventory off
    // must refuse a convert that would persist inventory / assembly / kit.
    if (!(await isFeatureEnabled(orgId, 'inventory'))) {
      const itemIds = [...new Set(
        lines.rows.map((line) => line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
      )]
      for (const itemId of itemIds) {
        const item = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`))
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          throw new WipBillingError('Inventory is disabled', 404)
        }
      }
    }
    // Stored prebill lines and existing invoices stay. Turning Equipment off
    // must refuse a convert that would persist equipment_charge.
    if (!(await isFeatureEnabled(orgId, 'equipment'))) {
      const itemIds = [...new Set(
        lines.rows.map((line) => line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
      )]
      for (const itemId of itemIds) {
        const item = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`))
        if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
          throw new WipBillingError('Equipment is disabled', 404)
        }
      }
    }

    const invoiceNumber = await nextDocumentNumber(orgId, 'customer_invoice', 'INV-', worksheet.subsidiary_id)

    const defaultIncome = (await tx.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
       order by number nulls last limit 1
    `))
    const fallbackIncomeAccountId = defaultIncome.rows[0]?.id
    if (!fallbackIncomeAccountId && lines.rows.some((line) => !line.income_account_id)) {
      throw new WipBillingError('Configure an income account before converting this prebill')
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-request-number:${orgId}`}, 0))`)
    const requestNumberResult = (await tx.execute<{ n: string }>(sql`
      select coalesce(max((regexp_replace(request_number, '\\D', '', 'g'))::bigint), 0) as n
        from billing_requests where org_id = ${orgId} and request_number ~ '^BREQ-[0-9]+$'
    `))
    const requestNumber = `BREQ-${String(Number(requestNumberResult.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`
    const timeIds = lines.rows.filter((line) => line.time_entry_id).map((line) => line.time_entry_id)
    const sourceCostLineIds = lines.rows.filter((line) => line.document_line_id).map((line) => line.document_line_id)
    const requestResult = (await tx.execute<{ id: string }>(sql`
      insert into billing_requests (
        org_id, project_id, request_number, invoice_type, basis, cutoff_date,
        invoice_description, customer_po, billing_method_snapshot, selected_time_entry_ids,
        notes, status, custom, created_by, updated_by
      ) values (
        ${orgId}, ${worksheet.project_id}, ${requestNumber}, 'progress', ${policySnapshot.billingBasis ?? 'date_range'},
        ${worksheet.period_end}, ${`Prebill ${worksheet.worksheet_number}`}, ${worksheet.customer_po_number},
        ${worksheet.billing_method ?? 'time_and_materials'}, ${JSON.stringify(timeIds)}::jsonb,
        ${worksheet.notes}, 'open',
        ${JSON.stringify({ prebillId: id, selectedCostLineIds: sourceCostLineIds, policy: policySnapshot })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id
    `))
    const billingRequestId = requestResult.rows[0]!.id

    const invoiceResult = (await tx.execute<{ id: string }>(sql`
      insert into documents (
        org_id, kind, document_number, party_id, document_date, currency, status,
        project_id, subsidiary_id, billing_method, is_final_invoice, reference_number,
        memo, subtotal, tax_total, total, custom, created_by, updated_by
      ) values (
        ${orgId}, 'customer_invoice', ${invoiceNumber}, ${worksheet.customer_id}, ${worksheet.period_end},
        ${worksheet.currency}, 'draft', ${worksheet.project_id}, ${worksheet.subsidiary_id},
        ${worksheet.billing_method === 'fixed_price' ? 'fixed_price' : 'time_and_materials'}, false,
        ${worksheet.customer_po_number}, ${`Created from ${worksheet.worksheet_number}`},
        '0', '0', '0', ${JSON.stringify({ prebillId: id, billingRequestId, policy: policySnapshot })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id
    `))
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
      const invoiceLineResult = (await tx.execute<{ id: string }>(sql`
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
      `))
      const invoiceLineId = invoiceLineResult.rows[0]!.id
      await persistLineTaxComponents(orgId, invoiceLineId, calculated.components, actorId, tx)
      if (line.source_type === 'time_entry') {
        const stamped = (await tx.execute<{ id: string }>(sql`
          update time_entries set invoiced_by_line_id = ${invoiceLineId}, billing_status = 'billed', updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.time_entry_id}
             and status = 'approved' and is_billable and billing_status = 'unbilled'
           returning id
        `))
        if (!stamped.rows[0]) throw new WipBillingError(`Time source on line ${line.line_number} is no longer available`)
      } else {
        const stamped = (await tx.execute<{ id: string }>(sql`
          update document_lines set billed_by_line_id = ${invoiceLineId}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.document_line_id} and billed_by_line_id is null
           returning id
        `))
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

function eligibleWipSources(orgId: string, asOf: string) {
  return sql`
    with raw_sources as (
      select 'time_entry'::text as source_type, te.id as source_id, te.project_id,
             te.worked_on as source_date, te.hours::numeric as quantity,
             round(te.hours * coalesce(te.cost_rate, 0), 4) as direct_cost,
             round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4) as native_bill,
             null::text as document_kind, null::text as document_status
        from time_entries te
        left join items item on item.org_id = te.org_id and item.id = te.item_id
       where te.org_id = ${orgId} and te.status = 'approved' and te.is_billable
         and te.billing_status = 'unbilled'
      union all
      select 'document_line'::text, line.id, coalesce(line.project_id, document.project_id),
             document.document_date, case when document.kind = 'project_charge' then line.quantity else 1 end,
             case when document.kind = 'project_charge' then coalesce(line.cost_amount, line.amount)
                  when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end,
             case when document.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                  when line.bill_amount is not null then case when document.kind in ('vendor_credit', 'card_refund') then -line.bill_amount else line.bill_amount end
                  when line.markup_percent is not null then round((case when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * (1 + line.markup_percent / 100), 4)
                  else round((case when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * coalesce(nullif(line.cost_multiplier, 0), 1), 4) end,
             document.kind, document.status
        from document_lines line
        join documents document on document.org_id = line.org_id and document.id = line.document_id
       where line.org_id = ${orgId} and line.is_billable and line.billed_by_line_id is null
         and coalesce(line.project_id, document.project_id) is not null
    ), policy_sources as (
      select source.*, project.contract_value,
             coalesce((project.custom->>'markupPercent')::numeric, 0) as project_markup,
             type.invoicing_profile,
             coalesce(version.financial_profile, type.financial_profile) as profile
        from raw_sources source
        join projects project on project.org_id = ${orgId} and project.id = source.project_id
          and project.status not in ('closed', 'cancelled')
        join project_types type on type.org_id = ${orgId} and type.id = project.project_type_id and type.is_active
        left join lateral (
          select policy.financial_profile
            from project_financial_profile_versions policy
           where policy.org_id = ${orgId} and policy.project_type_id = type.id
             and policy.effective_from <= source.source_date
             and (policy.effective_to is null or policy.effective_to >= source.source_date)
           order by policy.effective_from desc limit 1
        ) version on true
       where coalesce(type.invoicing_profile->>'billingProcedure', 'standard') = 'standard'
         and type.invoicing_profile->>'lineBuilder' in ('tm_actual', 'cost_plus')
         and (type.invoicing_profile->'allowedBases' ? 'time_selection'
           or type.invoicing_profile->'allowedBases' ? 'date_range')
    ), valued_sources as (
      select source.*,
             case when source.profile#>>'{billableValue,timeRate}' = 'cost_times_markup'
                  then round(source.direct_cost * (1 + coalesce(nullif(source.project_markup, 0), nullif(source.profile#>>'{totalPrice,defaultMarkupPercent}', '')::numeric, 0) / 100), 4)
                  else source.native_bill end as source_value,
             exists(select 1 from wip_holds hold where hold.org_id=${orgId}
                      and hold.source_type=source.source_type and hold.source_id=source.source_id
                      and hold.released_at is null) as held,
             exists(select 1 from wip_prebill_lines reserved
                      join wip_prebills worksheet on worksheet.org_id=reserved.org_id and worksheet.id=reserved.prebill_id
                     where reserved.org_id=${orgId} and reserved.source_type=source.source_type
                       and coalesce(reserved.time_entry_id,reserved.document_line_id)=source.source_id
                       and worksheet.status in ('draft','review','approved')) as reserved
        from policy_sources source
       where (source.source_type='time_entry'
              and coalesce((source.profile#>>'{billableValue,includeUnbilledTime}')::boolean, true))
          or (source.source_type='document_line'
              and coalesce((source.profile#>>'{billableValue,includeUnbilledCostLines}')::boolean, true)
              and (source.document_kind='project_charge'
                   or coalesce(source.profile#>'{billableValue,costSourceKinds}', '["vendor_bill","expense_report","card_charge","check"]'::jsonb) ? source.document_kind)
              and coalesce(source.profile#>'{billableValue,costSourceStatuses}', '["approved","posted"]'::jsonb) ? source.document_status)
    ), available_sources as (
      select source.*,
             case when source.held or source.reserved then 0 else source.source_value end as available_value,
             case when source.profile#>>'{totalPrice,method}' = 'not_to_exceed' then greatest(
               coalesce(source.contract_value,0)
               - coalesce((select sum(case when invoice.kind = any(array(select jsonb_array_elements_text(coalesce(source.profile#>'{invoicedToDate,creditKinds}','["customer_credit"]'::jsonb)))) then -line.amount else line.amount end)
                             from document_lines line join documents invoice on invoice.org_id=line.org_id and invoice.id=line.document_id
                            where line.org_id=${orgId} and coalesce(line.project_id,invoice.project_id)=source.project_id
                              and invoice.status='posted'
                              and invoice.kind = any(array(select jsonb_array_elements_text(coalesce(source.profile#>'{invoicedToDate,docKinds}','["customer_invoice"]'::jsonb) || coalesce(source.profile#>'{invoicedToDate,creditKinds}','["customer_credit"]'::jsonb))))),0)
               - coalesce((select sum(worksheet.proposed_bill_amount) from wip_prebills worksheet
                            where worksheet.org_id=${orgId} and worksheet.project_id=source.project_id
                              and worksheet.status in ('draft','review','approved')),0),
               0
             ) else null end as remaining_cap
        from valued_sources source
    ), ordered_sources as (
      select source.*,
             coalesce(sum(source.available_value) over (
               partition by source.project_id order by source.source_date, source.source_type, source.source_id
               rows between unbounded preceding and 1 preceding
             ),0) as prior_available
        from available_sources source
    ), eligible_sources as (
      select source.*,
             case when source.remaining_cap is null then source.available_value
                  when source.available_value < 0 then source.available_value
                  else greatest(least(source.available_value, source.remaining_cap-source.prior_available),0) end as capped_available_value
        from ordered_sources source
    )
  `
}

export async function wipAnalytics(orgId: string, asOf?: string): Promise<WipAnalytics> {
  const asOfDate = asOf ?? (await businessToday(orgId))
  requireDate(asOfDate, 'As-of date')
  const [agingResult, realizationResult, leakageResult] = await Promise.all([
    db.execute<WipAnalytics['aging']>(sql`
      ${eligibleWipSources(orgId, asOfDate)}
      select coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date <= 0),0)::text as current,
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 1 and 30),0)::text as "days1to30",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 31 and 60),0)::text as "days31to60",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 61 and 90),0)::text as "days61to90",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date > 90),0)::text as "over90",
             coalesce(sum(source_value) filter (where held),0)::text as held
        from eligible_sources
    `),
    db.execute<{ original: string; billed: string; adjustment: string }>(sql`
      select coalesce(sum(original_bill_amount),0)::text as original,
             coalesce(sum(proposed_bill_amount),0)::text as billed,
             coalesce(sum(adjustment_amount),0)::text as adjustment
        from wip_prebills where org_id=${orgId} and status='converted'
    `),
    db.execute<{ write_downs: string }>(sql`
      select coalesce(sum(-line.adjustment_amount) filter (where line.adjustment_amount < 0),0)::text as write_downs
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id=line.org_id and worksheet.id=line.prebill_id
       where line.org_id=${orgId} and worksheet.status in ('approved','converted')
    `),
  ])
  const aging = agingResult.rows[0] ?? { current: '0', days1to30: '0', days31to60: '0', days61to90: '0', over90: '0', held: '0' }
  const realization = realizationResult.rows[0] ?? { original: '0', billed: '0', adjustment: '0' }
  const original = Number(realization.original)
  const percent = original === 0 ? null : Number(realization.billed) / original
  const heldOver90Result = (await db.execute<{ amount: string }>(sql`
    ${eligibleWipSources(orgId, asOfDate)}
    select coalesce(sum(source_value) filter (where held and ${asOfDate}::date-source_date > 90),0)::text as amount
      from eligible_sources
  `))
  const writeDowns = leakageResult.rows[0]?.write_downs ?? '0'
  const heldOver90 = heldOver90Result.rows[0]?.amount ?? '0'
  return {
    aging,
    realization: { ...realization, percent },
    leakage: { writeDowns, heldOver90, total: add(writeDowns, heldOver90) },
  }
}

export async function listWipProjects(orgId: string): Promise<WipProjectOption[]> {
  const result = (await db.execute<{ id: string; name: string; customerName: string | null; projectTypeName: string; invoicingProfile: InvoicingProfile }>(sql`
    select project.id, project.name, customer.display_name as "customerName",
           type.name as "projectTypeName", type.invoicing_profile as "invoicingProfile"
      from projects project
      left join parties customer on customer.org_id=project.org_id and customer.id=project.customer_id
      join project_types type on type.org_id=project.org_id and type.id=project.project_type_id and type.is_active
     where project.org_id=${orgId} and project.status not in ('closed','cancelled')
     order by project.name
  `))
  return result.rows.flatMap((row) => sourceLinePrebillingReason(row.invoicingProfile) == null
    ? [{ id: row.id, name: row.name, customerName: row.customerName, projectTypeName: row.projectTypeName, lineBuilder: row.invoicingProfile.lineBuilder }]
    : [])
}
