import type { FinancialProfile, InvoicingProfile } from '@openbooks/schema'
import { add, cmp, mul, mulPercent, neg, normalizeMoney } from '@openbooks/engine/src/money.ts'

export type WipPolicyVersion = {
  id: string | null
  effectiveFrom: string
  effectiveTo: string | null
  financialProfile: FinancialProfile
}

export type WipPricingSource = {
  sourceType: 'time_entry' | 'document_line'
  sourceDate: string
  documentKind: string | null
  documentStatus: string | null
  directCostAmount: string
  nativeBillAmount: string
  quantity: string
  costingBasis?: string | null
  rateEngineOverhead?: string
}

export type PricedWipSource = {
  eligible: boolean
  reason: string | null
  directCostAmount: string
  overheadAmount: string
  loadedCostAmount: string
  billAmount: string
  pricingMode: 'bill_rate' | 'cost_times_markup'
  markupPercent: string
}

const DEFAULT_COST_KINDS = ['vendor_bill', 'expense_report', 'card_charge', 'check']
const DEFAULT_COST_STATUSES = ['approved', 'posted']

export function sourceLinePrebillingReason(invoicing: InvoicingProfile): string | null {
  if ((invoicing.billingProcedure ?? 'standard') !== 'standard') {
    return 'This project type uses applications for payment instead of source-line prebilling.'
  }
  if (!['tm_actual', 'cost_plus'].includes(invoicing.lineBuilder)) {
    return 'This project type bills milestones or draws instead of source-line prebilling.'
  }
  if (!(invoicing.allowedBases ?? []).some((basis) => basis === 'time_selection' || basis === 'date_range')) {
    return 'This project type has no time-selection or date-range billing basis.'
  }
  return null
}

export function effectiveWipPolicy(
  versions: WipPolicyVersion[],
  fallback: FinancialProfile,
  sourceDate: string,
): WipPolicyVersion {
  return versions.find((version) => (
    version.effectiveFrom <= sourceDate
      && (version.effectiveTo == null || version.effectiveTo >= sourceDate)
  )) ?? {
    id: null,
    effectiveFrom: '0001-01-01',
    effectiveTo: null,
    financialProfile: fallback,
  }
}

function effectiveMarkup(profile: FinancialProfile, projectMarkupPercent: string): string {
  return cmp(projectMarkupPercent, '0') === 0 && profile.totalPrice.defaultMarkupPercent != null
    ? normalizeMoney(String(profile.totalPrice.defaultMarkupPercent))
    : normalizeMoney(projectMarkupPercent)
}

export function priceWipSource(
  profile: FinancialProfile,
  source: WipPricingSource,
  projectMarkupPercent: string,
): PricedWipSource {
  const directCostAmount = normalizeMoney(source.directCostAmount)
  const nativeBillAmount = normalizeMoney(source.nativeBillAmount)
  const markupPercent = effectiveMarkup(profile, projectMarkupPercent)

  if (source.sourceType === 'time_entry' && !profile.billableValue.includeUnbilledTime) {
    return { eligible: false, reason: 'Unbilled time is excluded by the effective project-type policy.', directCostAmount, overheadAmount: '0.0000', loadedCostAmount: directCostAmount, billAmount: '0.0000', pricingMode: profile.billableValue.timeRate, markupPercent }
  }
  if (source.sourceType === 'document_line') {
    if (!profile.billableValue.includeUnbilledCostLines) {
      return { eligible: false, reason: 'Unbilled cost lines are excluded by the effective project-type policy.', directCostAmount, overheadAmount: '0.0000', loadedCostAmount: directCostAmount, billAmount: '0.0000', pricingMode: profile.billableValue.timeRate, markupPercent }
    }
    const kinds = profile.billableValue.costSourceKinds?.length ? profile.billableValue.costSourceKinds : DEFAULT_COST_KINDS
    if (source.documentKind !== 'project_charge' && !kinds.includes(source.documentKind ?? '')) {
      return { eligible: false, reason: 'The source document kind is excluded by the effective project-type policy.', directCostAmount, overheadAmount: '0.0000', loadedCostAmount: directCostAmount, billAmount: '0.0000', pricingMode: profile.billableValue.timeRate, markupPercent }
    }
    const statuses = profile.billableValue.costSourceStatuses?.length ? profile.billableValue.costSourceStatuses : DEFAULT_COST_STATUSES
    if (!statuses.includes(source.documentStatus as never)) {
      return { eligible: false, reason: 'The source document status is excluded by the effective project-type policy.', directCostAmount, overheadAmount: '0.0000', loadedCostAmount: directCostAmount, billAmount: '0.0000', pricingMode: profile.billableValue.timeRate, markupPercent }
    }
  }

  const billAmount = profile.billableValue.timeRate === 'cost_times_markup'
    ? add(directCostAmount, mulPercent(directCostAmount, markupPercent))
    : nativeBillAmount
  let overheadAmount = '0.0000'
  if (source.sourceType === 'time_entry' && profile.totalCost.components.includes('overhead')) {
    if (profile.overhead.method === 'percent_of_labor') {
      overheadAmount = mulPercent(directCostAmount, String(profile.overhead.ratePercent ?? 0))
    } else if (profile.overhead.method === 'per_labor_hour') {
      overheadAmount = mul(source.quantity, String(profile.overhead.ratePerHour ?? 0))
    } else if (profile.overhead.method === 'rate_engine') {
      overheadAmount = normalizeMoney(source.rateEngineOverhead ?? '0')
    }
  }

  return {
    eligible: cmp(billAmount, '0') !== 0,
    reason: cmp(billAmount, '0') === 0 ? 'The effective project-type policy produced no billable value.' : null,
    directCostAmount,
    overheadAmount,
    loadedCostAmount: add(directCostAmount, overheadAmount),
    billAmount,
    pricingMode: profile.billableValue.timeRate,
    markupPercent,
  }
}

export function capWipSources<T extends { billAmount: string }>(
  sources: T[],
  remainingCap: string | null,
): Array<T & { cappedBillAmount: string }> {
  if (remainingCap == null) return sources.map((source) => ({ ...source, cappedBillAmount: normalizeMoney(source.billAmount) }))
  let remaining = normalizeMoney(remainingCap)
  return sources.flatMap((source) => {
    if (cmp(remaining, '0') <= 0) return []
    const billAmount = normalizeMoney(source.billAmount)
    const cappedBillAmount = cmp(billAmount, remaining) > 0 ? remaining : billAmount
    remaining = add(remaining, neg(cappedBillAmount))
    return cmp(cappedBillAmount, '0') !== 0 ? [{ ...source, cappedBillAmount }] : []
  })
}
