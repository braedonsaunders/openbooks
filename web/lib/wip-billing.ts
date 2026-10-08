import 'server-only'
import { projectContractCapacityUsed } from '@openbooks/engine/projects/billing-pricing'
import { eligibleWipSourcesSql } from '@openbooks/engine/projects/wip-sources'
import { workCompletedOn, workPeriodOf } from '@openbooks/engine/records/work-period'
export { projectContractCapacityUsed } from '@openbooks/engine/projects/billing-pricing'

import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { appBaseUrl, runRecordFlows, WIP_PREBILL_SUBJECT_KIND } from '@openbooks/engine/flows'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { add, allocateLargestRemainder, cmp, mul, mulPercent, normalizeMoney, sum } from '@openbooks/engine/src/money/money.ts'
import { documentRevisionCounterSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { canonicalDecimal } from './exact-decimal'
import { computeLineTaxes } from '@openbooks/engine/src/tax/tax.ts'
import {
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from '@openbooks/engine/src/tax/persist.ts'
import { nextDocumentNumber } from "./bills.ts";
import { acquireFeatureGateLock, isFeatureEnabled } from './features'
import {
  PORTAL_ACTOR_ID,
  PORTAL_REVIEW_INVITE_TTL_DAYS,
  currentBillingReviewDigest,
  issuePortalReviewInvite,
  recordPortalEvent,
} from '@openbooks/engine/portal'
import { billingReviewRequestEmail, deriveEmailDeliveryKey, sendVia } from '@openbooks/emails'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/delivery/email-config'
import { createMoneyFormatter } from './money-format'

import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import {
  lockProjectForScope,
  ScopeNotFoundError,
  withScopeSnapshot,
} from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { subsidiaryVisibleFilter } from './subsidiaries'
import type { FinancialProfile, InvoicingProfile } from '@openbooks/schema'
import {
  capWipSources,
  effectiveWipPolicy,
  priceWipSource,
  sourceLinePrebillingReason,
  type WipPolicyVersion,
} from './wip-billing-policy'
import { prebillStage, type PrebillStage } from './pre-billing-stages'
export { PREBILL_STAGES, prebillStage, type PrebillStage } from './pre-billing-stages'

export type WipSourceType = 'time_entry' | 'document_line'
export type PrebillStatus = 'draft' | 'review' | 'approved' | 'customer_review' | 'converted' | 'void'

export class WipBillingError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'WipBillingError'
  }
}

async function assertWipBillingEnabled(orgId: string): Promise<void> {
  const [projects, wipBilling] = await Promise.all([
    isFeatureEnabled(orgId, 'projects'),
    isFeatureEnabled(orgId, 'wipBilling'),
  ])
  if (!projects || !wipBilling) throw new WipBillingError('Pre-billing is turned off — enable it on Company Settings → Features', 404)
}

async function assertWipBillingEnabledTx(tx: Executor, orgId: string): Promise<void> {
  await acquireFeatureGateLock(orgId, tx)
  const projects = await lockAndCheckOrgFeature(tx, orgId, 'projects')
  const wipBilling = await lockAndCheckOrgFeature(tx, orgId, 'wipBilling')
  if (!projects || !wipBilling) throw new WipBillingError('Pre-billing is turned off — enable it on Company Settings → Features', 404)
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function persistMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new WipBillingError(`${label} must be an exact decimal`)
  let amount: string
  try {
    amount = normalizeMoney(exact)
  } catch {
    throw new WipBillingError(`${label} must be an exact decimal`)
  }
  // Proposed amounts land in numeric(19,4) columns: fifteen whole digits. A
  // pasted wider figure normalized fine and died only in the update with a
  // storage error — fail closed here with a named error.
  if (amount.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) {
    throw new WipBillingError(`${label} is out of range — at most 15 whole digits fit the ledger`)
  }
  return amount
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
  /** Where the worksheet sits on the pre-billing board; see prebillStage. */
  stage: PrebillStage
  projectTypeName: string | null
  lineCount: number
  heldLineCount: number
  disputedLineCount: number
  /** The project type requires customer acceptance before invoicing. */
  customerReviewRequired: boolean
  customerReviewSentAt: string | null
  customerDecision: 'accepted' | 'disputed' | null
  customerDecidedAt: string | null
  customerSignerName: string | null
  customerDecisionNote: string | null
  customerPoNumber: string | null
  customerViewedAt: string | null
  invoiceStatus: string | null
  invoiceTotal: string | null
  invoiceOpenBalance: string | null
  deliveredAt: string | null
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
  customerDisputeNote: string | null
  /** Opaque optimistic-concurrency token: the line's canonical revision when read. */
  updatedAt: string
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
/**
 * The caller's subsidiary visibility (authz.allowedSubsidiaryIds): null is
 * unrestricted, a set (even empty) fails closed. Every entry point applies it
 * to the worksheet's PROJECT, so a worksheet on a hidden project is missing —
 * in lists, analytics, by id, and for every write.
 */
type SubsidiaryScope = ReadonlySet<string> | null

/** One locked wip_prebills header plus the joined project context conversion needs. */
interface WipPrebillHeaderRow extends Record<string, unknown> {
  status: string
  customer_id: string | null
  currency: string | null
  subsidiary_id: string | null
  project_id: string
  period_end: string
  proposed_bill_amount: string
  worksheet_number: string
  customer_po_number: string | null
  billing_method: string | null
  notes: string | null
  custom: Record<string, unknown> | null
  invoice_document_id: string | null
  customer_decision: string | null
}

/** One convertible wip_prebill_lines row plus its hold flag. */
interface WipPrebillLineRow extends Record<string, unknown> {
  id: string
  org_id: string
  prebill_id: string
  line_number: number
  source_type: string
  time_entry_id: string | null
  document_line_id: string | null
  document_id: string | null
  project_id: string
  source_date: string
  item_id: string | null
  income_account_id: string | null
  description: string | null
  quantity: string
  unit: string | null
  amount: string
  bill_amount: string
  proposed_bill_amount: string
  original_bill_amount: string
  cost_amount: string
  adjustment_amount: string
  cost_multiplier: string | null
  markup_percent: string | null
  tax_code_id: string | null
  time_type_id: string | null
  employee_party_id: string | null
  department_id: string | null
  disposition: string
  is_billable: boolean | null
  billed_by_line_id: string | null
  actively_held: boolean
}

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
  scope: SubsidiaryScope = null,
): Promise<ProjectPolicyContext> {
  const project = (await executor.execute<{
    id: string
    project_type_id: string | null
    contract_value: string
    markup_percent: string
    key: string | null
    name: string | null
    billing_method: string | null
    invoicing_profile: InvoicingProfile | null
  }>(sql`
    select project.id, project.project_type_id, coalesce(project.contract_value, 0)::text as contract_value,
           coalesce((project.custom->>'markupPercent')::numeric, 0)::text as markup_percent,
           type.key, type.name, type.billing_method, type.invoicing_profile
      from projects project
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
     where project.org_id = ${orgId} and project.id = ${projectId}
       and project.status not in ('closed', 'cancelled')
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     ${lock ? sql`for update of project` : sql``}
  `))
  const row = project.rows[0]
  if (!row) throw new WipBillingError('Project not found or is no longer active', 404)
  if (!row.project_type_id || !row.invoicing_profile) {
    throw new WipBillingError('Assign an active project type before creating a prebill')
  }
  // The financial policy is the effective-dated version history — the ONLY
  // place a profile lives. The newest published version is the fallback for a
  // source dated before the first window; no published version fails closed.
  const versions = (await executor.execute<WipPolicyVersion>(sql`
    select id, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           financial_profile as "financialProfile"
      from project_financial_profile_versions
     where org_id = ${orgId} and project_type_id = ${row.project_type_id}
     order by effective_from desc
  `))
  const latest = versions.rows[0]
  if (!latest) throw new WipBillingError('Publish a financial profile for the project type before creating a prebill')
  return {
    projectId: row.id,
    projectTypeId: row.project_type_id,
    projectTypeKey: row.key ?? 'project',
    projectTypeName: row.name ?? 'Project',
    billingMethod: row.billing_method,
    contractValue: normalizeMoney(row.contract_value),
    markupPercent: normalizeMoney(row.markup_percent),
    fallbackProfile: latest.financialProfile,
    invoicingProfile: row.invoicing_profile,
    versions: versions.rows,
  }
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
  // A ceiling that was never entered is unknown, not zero: billing-request
  // invoicing and Financials both read it that way (no ceiling ⇒ no cap),
  // so prebilling must agree instead of refusing every worksheet.
  if (cmp(policy.contractValue, '0') <= 0) return null
  const used = await projectContractCapacityUsed(executor, orgId, policy.projectId, profile.invoicedToDate, { excludePrebillId })
  const remaining = add(policy.contractValue, `-${used}`)
  return cmp(remaining, '0') > 0 ? remaining : '0.0000'
}

/**
 * Whether the CURRENT policy prices this project under an NTE ceiling as of
 * a date — independent of the worksheet's creation-time snapshot. A project
 * type switch after approval would otherwise silently drop a ceiling the
 * sibling billing path still enforces. Soft read: a missing type or
 * unpublished policy is simply not NTE here (the snapshot branch keeps its
 * own strict accounting), so this check can never strand a worksheet that
 * the snapshot branch would have let through.
 */
async function currentPolicyIsNte(
  executor: Executor,
  orgId: string,
  projectId: string,
  asOf: string,
): Promise<boolean> {
  const row = (await executor.execute<{ project_type_id: string | null }>(sql`
    select project_type_id from projects where id = ${projectId} and org_id = ${orgId}
  `));
  const typeId = row.rows[0]?.project_type_id;
  if (!typeId) return false;
  const versions = (await executor.execute<WipPolicyVersion>(sql`
    select id, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           financial_profile as "financialProfile"
      from project_financial_profile_versions
     where org_id = ${orgId} and project_type_id = ${typeId}
     order by effective_from desc
  `));
  const latest = versions.rows[0];
  if (!latest) return false;
  return effectiveWipPolicy(versions.rows, latest.financialProfile, asOf).financialProfile.totalPrice.method === 'not_to_exceed';
}

export function rateEngineOverhead(
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
  // Department specificity is per rate KIND, mirroring the posting rule
  // (`overheadRateAppliesToTimeEntry`): a department row steps aside only the
  // org-wide rows of its own kind, so rows of one scope still stack.
  const hasSpecificOfKind = (rateKind: OverheadRateRow['rate_kind']) => source.department_id != null
    && effective.some((rate) => rate.rate_kind === rateKind && rate.department_id === source.department_id)
  return sum(effective
    .filter((rate) => rate.department_id != null || !hasSpecificOfKind(rate.rate_kind))
    .map((rate) => rate.rate_kind === 'percent'
      ? mulPercent(source.direct_cost_amount, rate.rate)
      : mul(source.quantity, rate.rate)))
}

function requireDate(value: string, label: string): string {
  if (!isIsoCalendarDate(value)) {
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
export async function createPrebill(orgId: string, actorId: string, input: CreatePrebillInput, scope: SubsidiaryScope = null) {
  const periodEnd = requireDate(input.periodEnd, 'Period end')
  const periodStart = input.periodStart ? requireDate(input.periodStart, 'Period start') : null
  if (periodStart && periodStart > periodEnd) throw new WipBillingError('Period start must be on or before period end')

  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wip-prebill:${orgId}:${input.projectId}`}, 0))`)
    const policy = await loadProjectPolicy(tx, orgId, input.projectId, true, scope)
    const procedureReason = sourceLinePrebillingReason(policy.invoicingProfile)
    if (procedureReason) throw new WipBillingError(procedureReason)
    const cutoffPolicy = effectiveWipPolicy(policy.versions, policy.fallbackProfile, periodEnd)
    const remainingCap = await remainingContractCapacity(tx, orgId, policy, periodEnd)
    if (remainingCap != null && cmp(remainingCap, '0') <= 0) {
      throw new WipBillingError('The project has reached its not-to-exceed contract cap')
    }

    // The project lock above serialises source reservation, but worksheet
    // numbers are unique per ORGANIZATION (wip_prebills_org_number): two
    // creates for different projects would read the same max()+1 and the
    // loser would die on the unique index. This org-scoped lock serialises
    // the read below — the billing-request-number:{org} pattern. (The
    // feature-gate fence taken first also serialises org-wide today, but
    // numbering correctness must not depend on that coincidence.)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wip-prebill-number:${orgId}`}, 0))`)
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
      customerReview: policy.invoicingProfile.customerReview ?? 'optional',
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

type PrebillListSqlRow = Omit<PrebillListRow, 'stage' | 'customerReviewRequired'> & { customerReview: string | null }

export async function listPrebills(orgId: string, projectId?: string, scope: SubsidiaryScope = null): Promise<PrebillListRow[]> {
  await assertWipBillingEnabled(orgId)
  const result = (await db.execute<PrebillListSqlRow>(sql`
    select worksheet.id,
           worksheet.worksheet_number as "worksheetNumber",
           worksheet.project_id as "projectId",
           project.name as "projectName",
           customer.display_name as "customerName",
           type.name as "projectTypeName",
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
           invoice.status as "invoiceStatus",
           invoice.total::text as "invoiceTotal",
           invoice.open_balance::text as "invoiceOpenBalance",
           worksheet.created_at as "createdAt",
           coalesce(lines.bill_lines, 0) as "lineCount",
           coalesce(lines.held_lines, 0) as "heldLineCount",
           coalesce(lines.disputed_lines, 0) as "disputedLineCount",
           worksheet.custom #>> '{policy,customerReview}' as "customerReview",
           worksheet.customer_review_sent_at as "customerReviewSentAt",
           worksheet.customer_decision as "customerDecision",
           worksheet.customer_decided_at as "customerDecidedAt",
           worksheet.customer_signer_name as "customerSignerName",
           worksheet.customer_decision_note as "customerDecisionNote",
           worksheet.customer_po_number as "customerPoNumber",
           worksheet.customer_viewed_at as "customerViewedAt",
           worksheet.delivered_at as "deliveredAt"
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
      left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
      left join lateral (
        select count(*) filter (where line.disposition = 'bill')::int as bill_lines,
               count(*) filter (where line.disposition = 'hold')::int as held_lines,
               count(*) filter (where nullif(btrim(line.customer_dispute_note), '') is not null)::int as disputed_lines
          from wip_prebill_lines line
         where line.org_id = worksheet.org_id and line.prebill_id = worksheet.id
      ) lines on true
     where worksheet.org_id = ${orgId}
       and (${projectId ?? null}::uuid is null or worksheet.project_id = ${projectId ?? null})
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     order by worksheet.created_at desc
  `))
  // Instants leave as ISO strings: the board and the portal-facing notices
  // render them client side, and node-pg hands timestamptz back as Date.
  const iso = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value)
  return result.rows.map(({ customerReview, ...row }) => ({
    ...row,
    createdAt: iso(row.createdAt)!,
    customerReviewSentAt: iso(row.customerReviewSentAt),
    customerDecidedAt: iso(row.customerDecidedAt),
    customerViewedAt: iso(row.customerViewedAt),
    deliveredAt: iso(row.deliveredAt),
    stage: prebillStage(row),
    customerReviewRequired: customerReview === 'required',
  }))
}

export async function loadPrebill(orgId: string, id: string, scope: SubsidiaryScope = null): Promise<PrebillDetail | null> {
  await assertWipBillingEnabled(orgId)
  // One REPEATABLE READ snapshot for header + details, with the project
  // locked (share) and scope rechecked inside it: a concurrent A→B rehome
  // between the header read and the detail reads refuses as not-found
  // instead of disclosing B's lines, events and totals.
  return withScopeSnapshot(orgId, async () => {
    const headers = await listPrebills(orgId, undefined, scope)
    const header = headers.find((row) => row.id === id)
    if (!header) return null
    try {
      await lockProjectForScope(db, orgId, header.projectId, scope, 'share')
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return null
      throw error
    }
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
             line.customer_dispute_note as "customerDisputeNote",
             ${documentRevisionCounterSql(sql`line.revision_seq`)} as "updatedAt",
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
  })
}

export async function updatePrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  input: UpdatePrebillLineInput,
  scope: SubsidiaryScope = null,
  options: { expectedRevision: string },
) {
  const proposed = persistMoney(input.proposedBillAmount, 'Proposed bill amount')
  const evidence = evidenceList(input.adjustmentEvidence)
  // Mandatory optimistic-concurrency evidence (same contract as document and
  // payment edits): two tabs adjusting one line must 409 instead of silently
  // overwriting each other's billed amounts.
  if (!isDocumentRevisionToken(options.expectedRevision)) {
    throw new WipBillingError('A current line revision is required; reload the worksheet and try again', 409)
  }
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const current = (await tx.execute<{ proposed: string; original: string; status: PrebillStatus; project_id: string; period_end: string; custom: { policy?: { totalPriceMethod?: string } }; other_proposed: string; revision: string }>(sql`
      select line.proposed_bill_amount::text as proposed, line.original_bill_amount::text as original,
             worksheet.status, worksheet.project_id, worksheet.period_end::text as period_end,
             worksheet.custom,
             ${documentRevisionCounterSql(sql`line.revision_seq`)} as revision,
             coalesce((select sum(other.proposed_bill_amount) from wip_prebill_lines other
                        where other.org_id = line.org_id and other.prebill_id = line.prebill_id
                          and other.id <> line.id and other.disposition = 'bill'), 0)::text as other_proposed
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of line, worksheet
    `))
    const before = current.rows[0]
    if (!before) throw new WipBillingError('Prebill line not found', 404)
    // Pin the project for the rest of this transaction and recheck scope
    // under the lock: the line/worksheet lock above does not stop a
    // concurrent A→B rehome from moving this edit onto B's project.
    try {
      await lockProjectForScope(tx, orgId, before.project_id, scope)
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw new WipBillingError('Prebill line not found', 404)
      throw error
    }
    if (before.status !== 'draft') throw new WipBillingError('Only a draft prebill can be edited')
    if (before.revision !== options.expectedRevision) {
      throw new WipBillingError('This line changed after you opened it; reload the worksheet and reapply your adjustment', 409)
    }
    if ((cmp(before.original, '0') >= 0 && cmp(proposed, '0') < 0) || (cmp(before.original, '0') < 0 && cmp(proposed, '0') > 0)) {
      throw new WipBillingError('A billing adjustment cannot reverse the source line sign')
    }
    const changed = cmp(proposed, before.original) !== 0
    const reason = input.adjustmentReason?.trim() || null
    if (changed && !reason) throw new WipBillingError('A reason is required for a write-up or write-down')
    if (changed && evidence.length === 0) throw new WipBillingError('Evidence is required for a write-up or write-down')
    if (before.custom?.policy?.totalPriceMethod === 'not_to_exceed'
        || (await currentPolicyIsNte(tx, orgId, before.project_id, before.period_end))) {
      // Lock the project and recheck scope in the same transaction: an
      // unlocked re-read would authorize a stale subsidiary when a
      // concurrent A→B rehome lands between the line lock above and this
      // policy read.
      const policy = await loadProjectPolicy(tx, orgId, before.project_id, true, scope)
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
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${actorId}
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
  scope: SubsidiaryScope = null,
) {
  const cleanReason = reason.trim()
  if (!cleanReason) throw new WipBillingError('A hold reason is required')
  const cleanEvidence = evidenceList(evidence)
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const target = (await tx.execute<{ project_id: string }>(sql`
      select worksheet.project_id
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
    `)).rows[0]
    if (!target) throw new WipBillingError('Prebill line not found', 404)
    try {
      await lockProjectForScope(tx, orgId, target.project_id, scope)
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw new WipBillingError('Prebill line not found', 404)
      throw error
    }
    const row = (await tx.execute<{ source_type: WipSourceType; source_id: string; project_id: string; status: PrebillStatus }>(sql`
      select line.source_type, coalesce(line.time_entry_id, line.document_line_id) as source_id,
             line.project_id, worksheet.status
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of line, worksheet
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

export async function releaseWipHold(orgId: string, actorId: string, holdId: string, reason: string, scope: SubsidiaryScope = null) {
  const releaseReason = reason.trim()
  if (!releaseReason) throw new WipBillingError('A release reason is required')
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    // Read only enough to find the project's serialization fence. The hold
    // stays unlocked until the project row is locked, so a concurrent rehome
    // cannot pass between authorization and release.
    const target = (await tx.execute<{ project_id: string }>(sql`
      select project_id from wip_holds
       where org_id = ${orgId} and id = ${holdId} and released_at is null
    `)).rows[0]
    if (!target) throw new WipBillingError('Active hold not found', 404)
    try {
      await lockProjectForScope(tx, orgId, target.project_id, scope)
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw new WipBillingError('Active hold not found', 404)
      throw error
    }
    const released = (await tx.execute<{ source_type: WipSourceType; source_id: string }>(sql`
      update wip_holds
         set released_at = now(), released_by = ${actorId}, release_reason = ${releaseReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${holdId} and project_id = ${target.project_id}
         and released_at is null
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
         and worksheet.project_id = ${target.project_id}
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

type LockedPrebillHeader = {
  status: PrebillStatus
  submitted_by: string | null
  created_by: string | null
  project_id: string
  period_end: string
  custom: { policy?: { totalPriceMethod?: string; customerReview?: string } }
}

/**
 * Lock a worksheet and its project for a lifecycle change, rechecking the
 * caller's subsidiary scope under the project lock: the worksheet lock alone
 * does not stop a concurrent A→B rehome from moving the change onto B.
 */
async function lockPrebillForLifecycle(tx: Tx, orgId: string, id: string, scope: SubsidiaryScope): Promise<LockedPrebillHeader> {
  const header = (await tx.execute<LockedPrebillHeader>(sql`
    select worksheet.status, worksheet.submitted_by, worksheet.created_by, worksheet.project_id,
           worksheet.period_end::text as period_end, worksheet.custom
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     for update of worksheet
  `)).rows[0]
  if (!header) throw new WipBillingError('Prebill not found', 404)
  try {
    await lockProjectForScope(tx, orgId, header.project_id, scope)
  } catch (error) {
    if (error instanceof ScopeNotFoundError) throw new WipBillingError('Prebill not found', 404)
    throw error
  }
  return header
}

/**
 * The commercial invariants a worksheet must hold to be submitted or
 * approved: at least one line to bill, every write-up and write-down
 * supported by a reason and evidence, and — under a not-to-exceed policy —
 * a total inside the remaining contract capacity.
 */
async function assertPrebillApprovable(
  tx: Tx,
  orgId: string,
  id: string,
  header: LockedPrebillHeader,
  scope: SubsidiaryScope,
): Promise<void> {
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
  `)).rows[0]!
  if (current.bill_lines === 0) throw new WipBillingError('A prebill must contain at least one billable line')
  if (current.unsupported_adjustments > 0) {
    throw new WipBillingError('Every write-up and write-down requires a reason and evidence')
  }
  if (header.custom?.policy?.totalPriceMethod === 'not_to_exceed'
      || (await currentPolicyIsNte(tx, orgId, header.project_id, header.period_end))) {
    const policy = await loadProjectPolicy(tx, orgId, header.project_id, true, scope)
    const capacity = await remainingContractCapacity(tx, orgId, policy, header.period_end, id)
    if (capacity != null && cmp(current.proposed_total, capacity) > 0) {
      throw new WipBillingError(`Prebill exceeds the remaining not-to-exceed capacity of ${capacity}`)
    }
  }
}

async function openApprovalGateCount(tx: Tx, orgId: string, id: string): Promise<number> {
  return (await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId} and subject_kind = ${WIP_PREBILL_SUBJECT_KIND}
       and subject_id = ${id} and status in ('pending', 'escalated')
  `)).rows[0]?.n ?? 0
}

/** Clear any earlier customer decision so a new review starts clean. */
const CLEAR_CUSTOMER_DECISION = sql`
  customer_review_sent_at = null, customer_review_sent_by = null, customer_review_digest = null,
  customer_decision = null, customer_decided_at = null, customer_signer_name = null,
  customer_decision_note = null`

/**
 * Submit a draft through Flows. An enabled tenant-authored on_submit flow may
 * raise approval gates, which park the worksheet in review until they
 * resolve; when none does, the worksheet approves immediately. There is no
 * default approver and no approval path outside Flows.
 */
async function submitPrebill(orgId: string, actorId: string, id: string, scope: SubsidiaryScope) {
  const outcome = await withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const header = await lockPrebillForLifecycle(tx, orgId, id, scope)
    if (header.status !== 'draft') throw new WipBillingError(`Cannot submit a ${header.status} prebill`)
    await assertPrebillApprovable(tx, orgId, id, header, scope)
    await tx.execute(sql`
      update wip_prebills
         set status = 'review', submitted_at = now(), submitted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `)
    await appendEvent(tx, orgId, id, actorId, 'submitted')
    await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: 'draft' }, after: { status: 'review' } })

    const routed = await runRecordFlows(
      { kind: 'on_submit', source: 'ui' },
      WIP_PREBILL_SUBJECT_KIND,
      id,
      { orgId, userId: actorId, allowedSubsidiaryIds: scope },
    )
    if (routed.failed) {
      // Keep the failed run (retryable once its flow is fixed) and the
      // worksheet in draft: a submission whose approval routing failed must
      // never be treated as "no approval required".
      await tx.execute(sql`
        update wip_prebills set status = 'draft', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}
      `)
      await appendEvent(tx, orgId, id, actorId, 'submit_failed', { reason: routed.error })
      return { status: 'draft' as PrebillStatus, flowError: routed.error ?? 'The approval workflow could not run' }
    }
    if (routed.gatesCreated > 0) return { status: 'review' as PrebillStatus, flowError: null }
    await approvePrebillInTx(tx, orgId, actorId, id, 'submit_without_approval_flow', scope)
    return { status: 'approved' as PrebillStatus, flowError: null }
  }))
  if (outcome.flowError) {
    throw new WipBillingError(`${outcome.flowError} — fix or disable the approval flow in Flows, then submit again`)
  }
  return { id, status: outcome.status }
}

async function approvePrebillInTx(
  tx: Tx,
  orgId: string,
  actorId: string,
  id: string,
  source: 'flows' | 'submit_without_approval_flow',
  scope: SubsidiaryScope,
) {
  const header = await lockPrebillForLifecycle(tx, orgId, id, scope)
  if (header.status === 'approved') return
  if (header.status !== 'review') throw new WipBillingError(`Cannot approve a ${header.status} prebill`)
  await assertPrebillApprovable(tx, orgId, id, header, scope)
  const updated = await tx.execute(sql`
    update wip_prebills
       set status = 'approved', approved_at = now(), approved_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${id} and status = 'review'
  `)
  if ((updated.rowCount ?? 0) !== 1) throw new WipBillingError('The prebill changed while approving; reload and try again', 409)
  await appendEvent(tx, orgId, id, actorId, 'approved', { source })
  await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: 'review' }, after: { status: 'approved' }, source })
}

/**
 * Deterministic approval release, called by Flows when every gate on the
 * worksheet has resolved. Runs inside the gate decision's transaction, so the
 * worksheet's status and the gate decision commit or roll back together.
 * Approval rechecks the worksheet's commercial invariants; rejection returns
 * it to draft with the approver's reason.
 */
export async function releasePrebillApproval(
  orgId: string,
  actorId: string,
  id: string,
  outcome: 'approved' | 'rejected',
  comment?: string | null,
) {
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    if (outcome === 'approved') {
      // Flows has already authorized the approver against the subject's
      // scope; the release acts under that grant, unrestricted by sentinel.
      await approvePrebillInTx(tx, orgId, actorId, id, 'flows', null)
      return
    }
    const header = await lockPrebillForLifecycle(tx, orgId, id, null)
    if (header.status !== 'review') throw new WipBillingError(`Cannot return a ${header.status} prebill`)
    const reason = comment?.trim() || 'Returned in approval flow'
    await tx.execute(sql`
      update wip_prebills set status = 'draft', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `)
    await appendEvent(tx, orgId, id, actorId, 'returned', { source: 'flows', reason })
    await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: 'review' }, after: { status: 'draft' }, reason })
  })
}

export async function transitionPrebill(
  orgId: string,
  actorId: string,
  id: string,
  action: 'submit' | 'reopen' | 'void',
  reason?: string,
  scope: SubsidiaryScope = null,
) {
  if (action === 'submit') return submitPrebill(orgId, actorId, id, scope)
  if (!reason?.trim()) throw new WipBillingError('A reason is required')
  const cleanReason = reason.trim()
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const header = await lockPrebillForLifecycle(tx, orgId, id, scope)
    if (header.status === 'review' && (await openApprovalGateCount(tx, orgId, id)) > 0) {
      throw new WipBillingError('This prebill is awaiting approval in Inbox — reject it there to return it to draft')
    }
    if (action === 'reopen') {
      // Reopening discards approval and any customer decision: the edited
      // worksheet goes through approval (and review, if used) again.
      if (!['review', 'approved', 'customer_review'].includes(header.status)) {
        throw new WipBillingError(`Cannot reopen a ${header.status} prebill`)
      }
      await tx.execute(sql`
        update wip_prebills
           set status = 'draft', approved_at = null, approved_by = null, ${CLEAR_CUSTOMER_DECISION},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}
      `)
      await appendEvent(tx, orgId, id, actorId, 'reopened', { reason: cleanReason, from: header.status })
      await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: header.status }, after: { status: 'draft' }, reason: cleanReason })
      return { id, status: 'draft' as PrebillStatus }
    }
    if (!['draft', 'review', 'approved', 'customer_review'].includes(header.status)) {
      throw new WipBillingError(`Cannot void a ${header.status} prebill`)
    }
    await tx.execute(sql`
      update wip_prebills
         set status = 'void', voided_at = now(), voided_by = ${actorId}, void_reason = ${cleanReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `)
    await appendEvent(tx, orgId, id, actorId, 'voided', { reason: cleanReason })
    await audit(tx, orgId, 'wip_prebills', id, actorId, { before: { status: header.status }, after: { status: 'void' }, reason: cleanReason })
    return { id, status: 'void' as PrebillStatus }
  })
}

/**
 * Convert an approved worksheet into the existing billing-request and document
 * model. Exact source rows are locked and stamped in the same transaction as
 * the draft customer invoice, making double billing impossible even if two
 * conversion requests race.
 */
export async function convertPrebill(orgId: string, actorId: string, id: string, scope: SubsidiaryScope = null) {
  await assertWipBillingEnabled(orgId)
  const existing = (await db.execute<{ status: PrebillStatus; invoice_id: string | null; invoice_number: string | null; subsidiary_id: string | null }>(sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id, project.subsidiary_id,
           invoice.document_number as invoice_number
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
  `))
  const observed = existing.rows[0]
  if (!observed) throw new WipBillingError('Prebill not found', 404)
  if (observed.status === 'converted' && observed.invoice_id) {
    return { id: observed.invoice_id, documentNumber: observed.invoice_number!, idempotent: true }
  }
  if (observed.status === 'customer_review') {
    throw new WipBillingError('This prebill is with the customer for review — wait for their decision, or reopen it')
  }
  if (observed.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
  return db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const header = (await tx.execute<WipPrebillHeaderRow>(sql`
      select worksheet.*, project.customer_id,
             coalesce(nullif(btrim(worksheet.customer_po_number), ''), project.customer_po_number) as customer_po_number,
             project.subsidiary_id,
             project.name as project_name, type.billing_method,
             coalesce(subsidiary.base_currency, org.base_currency) as currency
        from wip_prebills worksheet
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
        join orgs org on org.id = worksheet.org_id
        left join subsidiaries subsidiary on subsidiary.org_id = project.org_id and subsidiary.id = project.subsidiary_id
        left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
       where worksheet.org_id = ${orgId} and worksheet.id = ${id}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of worksheet
    `))
    const worksheet = header.rows[0]
    if (!worksheet) throw new WipBillingError('Prebill not found', 404)
    // Conversion mints a customer invoice: pin the project and recheck scope
    // under the lock before any line or document write.
    try {
      await lockProjectForScope(tx, orgId, worksheet.project_id, scope)
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw new WipBillingError('Prebill not found', 404)
      throw error
    }
    if (worksheet.status === 'converted' && worksheet.invoice_document_id) {
      const invoice = (await tx.execute<{ document_number: string }>(sql`
        select document_number from documents where org_id = ${orgId} and id = ${worksheet.invoice_document_id}
      `))
      return { id: worksheet.invoice_document_id, documentNumber: invoice.rows[0]!.document_number, idempotent: true }
    }
    if (worksheet.status === 'customer_review') {
      throw new WipBillingError('This prebill is with the customer for review — wait for their decision, or reopen it')
    }
    if (worksheet.status !== 'approved') throw new WipBillingError('Only an approved prebill can be converted')
    if (!worksheet.customer_id) throw new WipBillingError('The project has no customer to invoice')
    if ((worksheet.custom?.policy as { customerReview?: string } | undefined)?.customerReview === 'required'
        && worksheet.customer_decision !== 'accepted') {
      throw new WipBillingError('This project type requires customer acceptance before invoicing — send the prebill to the customer first')
    }
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
    if (policySnapshot.totalPriceMethod === 'not_to_exceed'
        || (await currentPolicyIsNte(tx, orgId, worksheet.project_id, worksheet.period_end))) {
      // Conversion mints the invoice: lock the project and recheck scope in
      // the same transaction so a concurrent rehome cannot bill B's project.
      const policy = await loadProjectPolicy(tx, orgId, worksheet.project_id, true, scope)
      const capacity = await remainingContractCapacity(tx, orgId, policy, worksheet.period_end, id)
      if (cmp(String(worksheet.proposed_bill_amount), capacity ?? '0') > 0) {
        throw new WipBillingError(`Prebill exceeds the remaining not-to-exceed capacity of ${capacity ?? '0.0000'}`)
      }
    }

    const lines = (await tx.execute<WipPrebillLineRow>(sql`
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

    // Approval freezes each source line's account. Never substitute another
    // chart account or re-read the item's current policy during conversion.
    // Validate before reserving a number, and retain the account locks until
    // conversion commits so deactivation cannot race the generated invoice.
    for (const line of lines.rows) {
      if (!line.income_account_id) {
        throw new WipBillingError(`Prebill line ${line.line_number} has no configured income account. Correct the source accounting configuration, void this prebill, and create a new prebill for approval.`)
      }
      const account = (await tx.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and id = ${line.income_account_id}
           and is_active and not is_summary
         for share
      `))
      if (!account.rows[0]) {
        throw new WipBillingError(`Prebill line ${line.line_number} requires an active, non-summary account in this organization. Correct the source accounting configuration, void this prebill, and create a new prebill for approval.`)
      }
    }

    const invoiceNumber = await nextDocumentNumber(orgId, 'customer_invoice', 'INV-', worksheet.subsidiary_id)

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
        memo, subtotal, tax_total, total, custom, work_completed_on, created_by, updated_by
      ) values (
        ${orgId}, 'customer_invoice', ${invoiceNumber}, ${worksheet.customer_id}, ${worksheet.period_end},
        ${worksheet.currency}, 'draft', ${worksheet.project_id}, ${worksheet.subsidiary_id},
        ${worksheet.billing_method === 'fixed_price' ? 'fixed_price' : 'time_and_materials'}, false,
        ${worksheet.customer_po_number}, ${`Created from ${worksheet.worksheet_number}`},
        '0', '0', '0', ${JSON.stringify({ prebillId: id, billingRequestId, policy: policySnapshot })}::jsonb,
        ${workCompletedOn(lines.rows.map((line) => workPeriodOf([line.source_date])))},
        ${actorId}, ${actorId}
      ) returning id
    `))
    const invoiceId = invoiceResult.rows[0]!.id
    const billedAmounts: string[] = []
    const billedTaxes: string[] = []

    // Approved lines price at four decimals but the invoice settles whole
    // minor units. Rounding each line independently can certify a total
    // nobody approved (two 0.0050 draws round to 0.02 against an approved
    // 0.01), so the rounded approved total is allocated across the lines by
    // largest remainder: the invoice lines sum to the approved total exactly.
    const settledAmounts = allocateLargestRemainder(
      lines.rows.map((line) => String(line.proposed_bill_amount)),
      2,
    )
    for (const [index, line] of lines.rows.entries()) {
      const inputAmount = settledAmounts[index]!
      const taxConfig = line.tax_code_id
        ? await loadTaxComponentConfig(orgId, line.tax_code_id, worksheet.period_end, tx)
        : []
      if (line.tax_code_id && taxConfig.length === 0) {
        throw new WipBillingError(`Tax code on line ${line.line_number} is inactive or has no effective rate`)
      }
      const calculated = computeLineTaxes(inputAmount, taxConfig)
      const amount = calculated.netAmount
      const taxAmount = calculated.taxTotal
      const accountId = line.income_account_id
      const invoiceLineResult = (await tx.execute<{ id: string }>(sql`
        insert into document_lines (
          org_id, document_id, line_number, item_id, account_id, description,
          quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
          employee_id, time_entry_id, time_type_id, is_billable, bill_rate, bill_amount,
          work_from, work_to, custom, created_by, updated_by
        ) values (
          ${orgId}, ${invoiceId}, ${index + 1}, ${line.item_id}, ${accountId}, ${line.description},
          ${line.quantity}, ${line.unit},
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount}, ${line.tax_code_id}, ${taxAmount}, ${line.department_id}, ${worksheet.project_id},
          ${line.employee_party_id}, ${line.time_entry_id}, ${line.time_type_id}, true,
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount}, ${line.source_date}, ${line.source_date},
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

/** WIP analytics read the one engine valuation of unbilled project work. */
function eligibleWipSources(orgId: string, scope: SubsidiaryScope) {
  return eligibleWipSourcesSql(orgId, scope)
}

export async function wipAnalytics(orgId: string, asOf?: string, scope: SubsidiaryScope = null): Promise<WipAnalytics> {
  await assertWipBillingEnabled(orgId)
  const asOfDate = asOf ?? (await businessToday(orgId))
  requireDate(asOfDate, 'As-of date')
  const [agingResult, realizationResult, leakageResult] = await Promise.all([
    db.execute<WipAnalytics['aging']>(sql`
      ${eligibleWipSources(orgId, scope)}
      select coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date <= 0),0)::text as current,
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 1 and 30),0)::text as "days1to30",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 31 and 60),0)::text as "days31to60",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 61 and 90),0)::text as "days61to90",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date > 90),0)::text as "over90",
             coalesce(sum(source_value) filter (where held),0)::text as held
        from eligible_sources
    `),
    db.execute<{ original: string; billed: string; adjustment: string }>(sql`
      select coalesce(sum(worksheet.original_bill_amount),0)::text as original,
             coalesce(sum(worksheet.proposed_bill_amount),0)::text as billed,
             coalesce(sum(worksheet.adjustment_amount),0)::text as adjustment
        from wip_prebills worksheet
        join projects project on project.org_id=worksheet.org_id and project.id=worksheet.project_id
       where worksheet.org_id=${orgId} and worksheet.status='converted'
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
    `),
    db.execute<{ write_downs: string }>(sql`
      select coalesce(sum(-line.adjustment_amount) filter (where line.adjustment_amount < 0),0)::text as write_downs
        from wip_prebill_lines line
        join wip_prebills worksheet on worksheet.org_id=line.org_id and worksheet.id=line.prebill_id
        join projects project on project.org_id=worksheet.org_id and project.id=worksheet.project_id
       where line.org_id=${orgId} and worksheet.status in ('approved','converted')
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
    `),
  ])
  const aging = agingResult.rows[0] ?? { current: '0', days1to30: '0', days31to60: '0', days61to90: '0', over90: '0', held: '0' }
  const realization = realizationResult.rows[0] ?? { original: '0', billed: '0', adjustment: '0' }
  const original = Number(realization.original)
  const percent = original === 0 ? null : Number(realization.billed) / original
  const heldOver90Result = (await db.execute<{ amount: string }>(sql`
    ${eligibleWipSources(orgId, scope)}
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

export async function listWipProjects(orgId: string, scope: SubsidiaryScope = null): Promise<WipProjectOption[]> {
  await assertWipBillingEnabled(orgId)
  const result = (await db.execute<{ id: string; name: string; customerName: string | null; projectTypeName: string; invoicingProfile: InvoicingProfile }>(sql`
    select project.id, project.name, customer.display_name as "customerName",
           type.name as "projectTypeName", type.invoicing_profile as "invoicingProfile"
      from projects project
      left join parties customer on customer.org_id=project.org_id and customer.id=project.customer_id
      join project_types type on type.org_id=project.org_id and type.id=project.project_type_id and type.is_active
     where project.org_id=${orgId} and project.status not in ('closed','cancelled')
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     order by project.name
  `))
  return result.rows.flatMap((row) => sourceLinePrebillingReason(row.invoicingProfile) == null
    ? [{ id: row.id, name: row.name, customerName: row.customerName, projectTypeName: row.projectTypeName, lineBuilder: row.invoicingProfile.lineBuilder }]
    : [])
}

// ---------------------------------------------------------------------------
// Customer review, delivery and bill runs
// ---------------------------------------------------------------------------

/** Whether an enabled flow routes pre-billing approvals for this organization. */
export async function prebillApprovalFlowsConfigured(orgId: string): Promise<boolean> {
  const row = (await db.execute<{ configured: boolean }>(sql`
    select exists (
      select 1 from flows
       where org_id = ${orgId} and subject_kind = ${WIP_PREBILL_SUBJECT_KIND} and enabled
    ) as configured
  `)).rows[0]
  return row?.configured === true
}

export interface SendPrebillToCustomerInput {
  to?: string | null
  message?: string | null
}

export interface SendPrebillToCustomerResult {
  id: string
  status: PrebillStatus
  emailed: boolean
  recipient: string
  emailError: string | null
}

type CustomerReviewContext = {
  customer_id: string | null
  customer_name: string | null
  customer_email: string | null
  project_name: string
  worksheet_number: string
  period_start: string | null
  period_end: string
  proposed_bill_amount: string
  currency: string | null
  customer_decision: string | null
}

async function customerRecipientEmail(tx: Tx, orgId: string, customerId: string): Promise<string | null> {
  const row = (await tx.execute<{ email: string | null }>(sql`
    select coalesce(
      nullif(btrim(party.email), ''),
      (select nullif(btrim(contact.email), '') from contacts contact
        where contact.org_id = party.org_id and contact.party_id = party.id
          and contact.is_active and nullif(btrim(contact.email), '') is not null
        order by contact.is_primary desc, contact.created_at
        limit 1)
    ) as email
      from parties party
     where party.org_id = ${orgId} and party.id = ${customerId}
  `)).rows[0]
  return row?.email ?? null
}

/**
 * Send an approved worksheet to its customer for review in the customer
 * portal. The worksheet freezes in `customer_review` with a fingerprint of
 * exactly what the customer is shown; the customer then accepts it (which
 * returns it to approved, ready to invoice) or disputes lines (which returns
 * it to draft). The invitation email is sent after the state commits: an
 * email failure leaves the review open in the portal and is reported, never
 * rolled into a silent success.
 */
export async function sendPrebillToCustomer(
  orgId: string,
  actorId: string,
  id: string,
  input: SendPrebillToCustomerInput,
  scope: SubsidiaryScope = null,
): Promise<SendPrebillToCustomerResult> {
  if (!(await isFeatureEnabled(orgId, 'customerPortal'))) {
    throw new WipBillingError('Customer review runs in the customer portal — turn on Customer portal on Company Settings → Features first')
  }
  const prepared = await withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
    await assertWipBillingEnabledTx(tx, orgId)
    const header = await lockPrebillForLifecycle(tx, orgId, id, scope)
    if (header.status !== 'approved') {
      throw new WipBillingError(`Only an approved prebill can be sent for customer review; this one is ${header.status}`)
    }
    const context = (await tx.execute<CustomerReviewContext>(sql`
      select project.customer_id, customer.display_name as customer_name, null::text as customer_email,
             project.name as project_name, worksheet.worksheet_number,
             worksheet.period_start::text as period_start, worksheet.period_end::text as period_end,
             worksheet.proposed_bill_amount::text as proposed_bill_amount,
             coalesce(subsidiary.base_currency, org.base_currency) as currency,
             worksheet.customer_decision
        from wip_prebills worksheet
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
        join orgs org on org.id = worksheet.org_id
        left join subsidiaries subsidiary on subsidiary.org_id = project.org_id and subsidiary.id = project.subsidiary_id
        left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
       where worksheet.org_id = ${orgId} and worksheet.id = ${id}
    `)).rows[0]!
    if (!context.customer_id) throw new WipBillingError('The project has no customer to review this billing')
    if (context.customer_decision === 'accepted') {
      throw new WipBillingError('The customer has already accepted this prebill — create the invoice')
    }
    if (!context.currency) throw new WipBillingError('The project subsidiary has no functional currency')
    const recipient = input.to?.trim() || (await customerRecipientEmail(tx, orgId, context.customer_id))
    if (!recipient) {
      throw new WipBillingError('The customer has no email address — add one to the customer or a contact, or enter one when sending')
    }
    const digest = await currentBillingReviewDigest(orgId, id, tx)
    if (!digest) throw new WipBillingError('Prebill not found', 404)
    const updated = await tx.execute(sql`
      update wip_prebills
         set status = 'customer_review',
             customer_decision = null, customer_decided_at = null, customer_signer_name = null,
             customer_decision_note = null,
             customer_review_sent_at = now(), customer_review_sent_by = ${actorId},
             customer_review_digest = ${digest}, customer_viewed_at = null,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and status = 'approved'
    `)
    if ((updated.rowCount ?? 0) !== 1) throw new WipBillingError('The prebill changed while sending; reload and try again', 409)
    await tx.execute(sql`
      update wip_prebill_lines set customer_dispute_note = null
       where org_id = ${orgId} and prebill_id = ${id} and customer_dispute_note is not null
    `)
    const invite = await issuePortalReviewInvite(orgId, context.customer_id, recipient, tx)
    await appendEvent(tx, orgId, id, actorId, 'customer_review_sent', { digest })
    await audit(tx, orgId, 'wip_prebills', id, actorId, {
      before: { status: 'approved' },
      after: { status: 'customer_review', customerReviewDigest: digest },
    })
    return { context, recipient, token: invite.token }
  }))

  const { context, recipient, token } = prepared
  const transport = await resolveOrgEmailTransport(orgId)
  const orgName = (await db.execute<{ name: string; portal_name: string | null }>(sql`
    select org.name,
           (select settings.portal_name from customer_portal_settings settings
             where settings.org_id = org.id and settings.effective_from <= current_date
             order by settings.effective_from desc limit 1) as portal_name
      from orgs org where org.id = ${orgId}
  `)).rows[0]
  let emailError: string | null = null
  if (!transport) {
    emailError = 'Email delivery is not configured — set it up in Admin → Email; the review is waiting in the customer portal'
  } else {
    const mail = billingReviewRequestEmail({
      orgName: orgName?.name ?? 'OpenBooks',
      portalName: orgName?.portal_name ?? 'Customer portal',
      partyName: context.customer_name,
      reference: context.worksheet_number,
      projectName: context.project_name,
      periodLabel: context.period_start ? `${context.period_start} – ${context.period_end}` : `work through ${context.period_end}`,
      amount: createMoneyFormatter('en', context.currency!).money(context.proposed_bill_amount),
      reviewUrl: `${appBaseUrl()}/portal/${token}?review=${id}`,
      expiresDays: PORTAL_REVIEW_INVITE_TTL_DAYS,
      message: input.message ?? undefined,
    })
    const logId = await insertEmailLog({
      orgId,
      recipients: [recipient],
      subject: mail.subject,
      status: 'queued',
      categoryKey: 'portal',
      meta: { event: 'billing_review_request', prebillId: id },
      actor: { kind: 'user', userId: actorId },
    })
    try {
      const outcome = await sendVia(transport, { to: recipient, subject: mail.subject, html: mail.html, text: mail.text }, {
        deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `direct:${logId}`, to: recipient }),
      })
      if (outcome.kind === 'sent') {
        await markEmailSent(orgId, logId, outcome.providerMessageId)
      } else {
        await markEmailUncertain(orgId, logId, outcome.reason)
        emailError = `The email provider did not confirm delivery (${outcome.reason}); the review is waiting in the customer portal`
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await markEmailFailed(orgId, logId, reason)
      emailError = `The review email could not be sent (${reason}); the review is waiting in the customer portal`
    }
    await withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
      await appendEvent(tx, orgId, id, actorId, emailError ? 'customer_review_email_failed' : 'customer_review_emailed', {
        emailLogId: logId,
        ...(emailError ? { reason: emailError } : {}),
      })
    }))
  }
  return { id, status: 'customer_review', emailed: emailError === null, recipient, emailError }
}

export interface PortalReviewDecisionBase {
  orgId: string
  partyId: string
  linkId: string
  prebillId: string
  /** The fingerprint the customer's page was rendered from. */
  digest: string
}

type PortalReviewTarget = {
  status: PrebillStatus
  worksheet_number: string
  customer_review_digest: string | null
  notify_user_ids: string[]
}

/** Lock a worksheet the session customer is reviewing, or refuse as not found. */
async function lockPortalReview(tx: Tx, input: PortalReviewDecisionBase): Promise<PortalReviewTarget> {
  await assertWipBillingEnabledTx(tx, input.orgId)
  const target = (await tx.execute<PortalReviewTarget>(sql`
    select worksheet.status, worksheet.worksheet_number, worksheet.customer_review_digest,
           array_remove(array[worksheet.customer_review_sent_by, worksheet.submitted_by, worksheet.created_by], null)::text[] as notify_user_ids
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
     where worksheet.org_id = ${input.orgId} and worksheet.id = ${input.prebillId}
       and project.customer_id = ${input.partyId}
     for update of worksheet
  `)).rows[0]
  if (!target || target.status !== 'customer_review') {
    throw new WipBillingError('This billing is no longer awaiting your review', 404)
  }
  const current = await currentBillingReviewDigest(input.orgId, input.prebillId, tx)
  if (!current || current !== target.customer_review_digest || current !== input.digest) {
    throw new WipBillingError('This billing changed after you opened it — reload the page to review the current version', 409)
  }
  return target
}

async function notifyPrebillTeam(tx: Tx, orgId: string, userIds: string[], prebillId: string, title: string, body: string) {
  // Notify the people who prepared, submitted and sent the worksheet. One who
  // has since left has no inbox; the worksheet trail still records the decision.
  await tx.execute(sql`
    insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
    select ${orgId}, member.id, 'pre_billing', ${title}, ${body}, ${`/projects/wip-billing?prebill=${prebillId}`},
           ${PORTAL_ACTOR_ID}::uuid, ${PORTAL_ACTOR_ID}::uuid
      from users member
     where member.id in (select jsonb_array_elements_text(${JSON.stringify([...new Set(userIds)])}::jsonb)::uuid)
  `)
}

/**
 * The customer accepts the package as shown. Acceptance names the signer and
 * may carry the customer's purchase order number, which the invoice then
 * references. The worksheet returns to approved, ready to invoice.
 */
export async function acceptPrebillReview(input: PortalReviewDecisionBase & {
  signerName: string
  purchaseOrderNumber?: string | null
  note?: string | null
}) {
  const signerName = input.signerName.trim()
  if (!signerName) throw new WipBillingError('Enter your name to accept this billing')
  if (signerName.length > 200) throw new WipBillingError('The name is too long — at most 200 characters')
  const po = input.purchaseOrderNumber?.trim() || null
  if (po && po.length > 100) throw new WipBillingError('The purchase order number is too long — at most 100 characters')
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new WipBillingError('The comment is too long — at most 2,000 characters')
  return withOrgTransaction(input.orgId, async () => db.transaction(async (tx) => {
    const target = await lockPortalReview(tx, input)
    await tx.execute(sql`
      update wip_prebills
         set status = 'approved', customer_decision = 'accepted', customer_decided_at = now(),
             customer_signer_name = ${signerName}, customer_decision_note = ${note},
             customer_po_number = coalesce(${po}, customer_po_number),
             updated_at = now(), updated_by = ${PORTAL_ACTOR_ID}::uuid
       where org_id = ${input.orgId} and id = ${input.prebillId} and status = 'customer_review'
    `)
    await appendEvent(tx, input.orgId, input.prebillId, PORTAL_ACTOR_ID, 'customer_accepted', {
      digest: input.digest,
      purchaseOrderProvided: po !== null,
      commented: note !== null,
    })
    await audit(tx, input.orgId, 'wip_prebills', input.prebillId, PORTAL_ACTOR_ID, {
      before: { status: 'customer_review' },
      after: { status: 'approved', customerDecision: 'accepted' },
      source: 'customer_portal',
    })
    await recordPortalEvent(tx, input.orgId, {
      partyId: input.partyId,
      linkId: input.linkId,
      action: 'billing_review_accepted',
      reasonCode: null,
      detail: { prebillId: input.prebillId },
    })
    await notifyPrebillTeam(tx, input.orgId, target.notify_user_ids, input.prebillId,
      `Customer accepted ${target.worksheet_number}`,
      po ? `Ready to invoice. Purchase order ${po} was provided.` : 'Ready to invoice.')
    return { id: input.prebillId, status: 'approved' as PrebillStatus }
  }))
}

/**
 * The customer disputes the package. Each disputed line carries the
 * customer's note; the worksheet returns to draft so the preparer can adjust,
 * hold or explain the lines and send it through approval again.
 */
export async function disputePrebillReview(input: PortalReviewDecisionBase & {
  note?: string | null
  lines: Array<{ lineId: string; note: string }>
}) {
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new WipBillingError('The comment is too long — at most 2,000 characters')
  const lines = input.lines
    .map((line) => ({ lineId: line.lineId, note: line.note.trim() }))
    .filter((line) => line.note.length > 0)
  if (lines.length === 0 && !note) {
    throw new WipBillingError('Tell us what needs attention — add a note to at least one line or a general comment')
  }
  if (lines.some((line) => line.note.length > 1000)) {
    throw new WipBillingError('A line note is too long — at most 1,000 characters')
  }
  return withOrgTransaction(input.orgId, async () => db.transaction(async (tx) => {
    const target = await lockPortalReview(tx, input)
    for (const line of lines) {
      const updated = await tx.execute(sql`
        update wip_prebill_lines set customer_dispute_note = ${line.note}
         where org_id = ${input.orgId} and prebill_id = ${input.prebillId} and id = ${line.lineId}
           and disposition = 'bill'
      `)
      if ((updated.rowCount ?? 0) !== 1) {
        throw new WipBillingError('A disputed line is not part of this billing — reload the page and try again', 409)
      }
    }
    await tx.execute(sql`
      update wip_prebills
         set status = 'draft', approved_at = null, approved_by = null,
             customer_decision = 'disputed', customer_decided_at = now(),
             customer_signer_name = null, customer_decision_note = ${note},
             updated_at = now(), updated_by = ${PORTAL_ACTOR_ID}::uuid
       where org_id = ${input.orgId} and id = ${input.prebillId} and status = 'customer_review'
    `)
    await appendEvent(tx, input.orgId, input.prebillId, PORTAL_ACTOR_ID, 'customer_disputed', {
      digest: input.digest,
      disputedLines: lines.length,
      commented: note !== null,
    })
    await audit(tx, input.orgId, 'wip_prebills', input.prebillId, PORTAL_ACTOR_ID, {
      before: { status: 'customer_review' },
      after: { status: 'draft', customerDecision: 'disputed' },
      source: 'customer_portal',
    })
    await recordPortalEvent(tx, input.orgId, {
      partyId: input.partyId,
      linkId: input.linkId,
      action: 'billing_review_disputed',
      reasonCode: null,
      detail: { prebillId: input.prebillId, disputedLines: lines.length },
    })
    await notifyPrebillTeam(tx, input.orgId, target.notify_user_ids, input.prebillId,
      `Customer disputed ${target.worksheet_number}`,
      lines.length > 0
        ? `${lines.length} line${lines.length === 1 ? '' : 's'} need attention. The prebill is back in draft.`
        : 'The prebill is back in draft with the customer\'s comment.')
    return { id: input.prebillId, status: 'draft' as PrebillStatus }
  }))
}

/** Record the first time the customer opens a package sent to them. */
export async function markPrebillViewedByCustomer(orgId: string, partyId: string, prebillId: string) {
  await withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
    const marked = (await tx.execute<{ id: string }>(sql`
      update wip_prebills worksheet
         set customer_viewed_at = now()
        from projects project
       where worksheet.org_id = ${orgId} and worksheet.id = ${prebillId}
         and project.org_id = worksheet.org_id and project.id = worksheet.project_id
         and project.customer_id = ${partyId}
         and worksheet.customer_viewed_at is null
         and worksheet.customer_review_sent_at is not null
      returning worksheet.id
    `)).rows[0]
    if (marked) await appendEvent(tx, orgId, prebillId, PORTAL_ACTOR_ID, 'customer_viewed')
  }))
}

/**
 * Email the invoice a worksheet produced to the customer with its backup
 * packet attached, and record the delivery on the worksheet. Only a posted
 * invoice is delivered. When the invoice's billing request requires backup,
 * the stored packet must exist — the same rule that guards issuing it.
 */
export async function deliverPrebillInvoice(
  orgId: string,
  actorId: string,
  id: string,
  input: { to?: string | null; message?: string | null },
  scope: SubsidiaryScope = null,
) {
  await assertWipBillingEnabled(orgId)
  const row = (await db.execute<{ status: PrebillStatus; invoice_id: string | null; invoice_status: string | null; invoice_number: string | null }>(sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id,
           invoice.status as invoice_status, invoice.document_number as invoice_number
      from wip_prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
  `)).rows[0]
  if (!row) throw new WipBillingError('Prebill not found', 404)
  if (row.status !== 'converted' || !row.invoice_id) throw new WipBillingError('Create the invoice before sending it')
  if (row.invoice_status !== 'posted') {
    throw new WipBillingError(`Post invoice ${row.invoice_number ?? ''} before sending it to the customer`.replace('  ', ' '))
  }
  // Delivery pulls in the PDF and file-cabinet graph only when it runs.
  const [{ loadInvoiceBackup, requireInvoiceBackup }, { sendRecordPdfEmail }] = await Promise.all([
    import('./invoice-backup'),
    import('./pdf-templates/send'),
  ])
  try {
    await requireInvoiceBackup(orgId, row.invoice_id)
  } catch (error) {
    // The backup refusal names its remedy; surface it as this command's refusal.
    if (error instanceof Error && 'code' in error && error.code === 'invoice_backup_required') {
      throw new WipBillingError(error.message)
    }
    throw error
  }
  const backup = await loadInvoiceBackup(orgId, row.invoice_id, scope)
  const sent = await sendRecordPdfEmail({
    recordType: 'customer_invoice',
    orgId,
    id: row.invoice_id,
    to: input.to ?? undefined,
    message: input.message ?? undefined,
    scope,
    extraAttachments: backup ? [{ filename: backup.filename, content: backup.bytes }] : [],
  })
  await withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
    await tx.execute(sql`
      update wip_prebills
         set delivered_at = now(), delivered_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and status = 'converted'
    `)
    await appendEvent(tx, orgId, id, actorId, 'delivered', { backupAttached: backup !== null })
  }))
  return { id, to: sent.to, backupAttached: backup !== null }
}

export type UnbilledProjectRow = {
  projectId: string
  projectName: string
  customerName: string | null
  projectTypeName: string
  unbilledAmount: string
  sourceCount: number
  oldestWorkDate: string
}

/**
 * Projects with unbilled work that no open worksheet has claimed yet — the
 * board's "to prebill" column and the population a bill run prepares.
 */
export async function listUnbilledProjects(orgId: string, scope: SubsidiaryScope = null): Promise<UnbilledProjectRow[]> {
  await assertWipBillingEnabled(orgId)
  const eligible = new Set((await listWipProjects(orgId, scope)).map((project) => project.id))
  const rows = (await db.execute<UnbilledProjectRow>(sql`
    ${eligibleWipSources(orgId, scope)}
    select source.project_id as "projectId", project.name as "projectName",
           customer.display_name as "customerName", coalesce(type.name, '') as "projectTypeName",
           sum(source.capped_available_value)::text as "unbilledAmount",
           count(*)::int as "sourceCount",
           min(source.source_date)::text as "oldestWorkDate"
      from eligible_sources source
      join projects project on project.org_id = ${orgId} and project.id = source.project_id
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
      left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
     where source.capped_available_value > 0
     group by source.project_id, project.name, customer.display_name, type.name
     order by min(source.source_date), project.name
  `)).rows
  return rows.filter((row) => eligible.has(row.projectId))
}

export interface BillRunInput {
  periodStart?: string | null
  periodEnd: string
  /** Limit the run to these projects; omitted means every project with unbilled work. */
  projectIds?: string[] | null
  notes?: string | null
}

export interface BillRunResult {
  created: Array<{ projectId: string; projectName: string; id: string; worksheetNumber: string; sourceCount: number }>
  skipped: Array<{ projectId: string; projectName: string; reason: string }>
}

/**
 * Prepare a worksheet for every project with unbilled work through a cutoff.
 * Each project is prepared in its own transaction with the same locking and
 * reservation rules as a single worksheet, so one project's refusal (no work
 * before the cutoff, an exhausted not-to-exceed cap, a missing policy) is
 * reported with its reason and never blocks the others.
 */
export async function runBillRun(
  orgId: string,
  actorId: string,
  input: BillRunInput,
  scope: SubsidiaryScope = null,
): Promise<BillRunResult> {
  const periodEnd = requireDate(input.periodEnd, 'Cutoff date')
  const periodStart = input.periodStart ? requireDate(input.periodStart, 'Period start') : null
  if (periodStart && periodStart > periodEnd) throw new WipBillingError('Period start must be on or before the cutoff date')
  const candidates = await listUnbilledProjects(orgId, scope)
  const wanted = input.projectIds?.length ? new Set(input.projectIds) : null
  const targets = wanted ? candidates.filter((row) => wanted.has(row.projectId)) : candidates
  if (wanted) {
    const unknown = [...wanted].filter((projectId) => !candidates.some((row) => row.projectId === projectId))
    if (unknown.length > 0) {
      throw new WipBillingError('A selected project has no unbilled work available to prebill — refresh and try again', 409)
    }
  }
  if (targets.length === 0) throw new WipBillingError('No project has unbilled work available to prebill')
  const result: BillRunResult = { created: [], skipped: [] }
  for (const target of targets) {
    try {
      const created = await createPrebill(orgId, actorId, {
        projectId: target.projectId,
        periodStart,
        periodEnd,
        notes: input.notes ?? null,
      }, scope)
      result.created.push({ projectId: target.projectId, projectName: target.projectName, ...created })
    } catch (error) {
      if (!(error instanceof WipBillingError)) throw error
      result.skipped.push({ projectId: target.projectId, projectName: target.projectName, reason: error.message })
    }
  }
  return result
}
