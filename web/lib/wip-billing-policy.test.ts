import assert from 'node:assert/strict'
import test from 'node:test'
import type { FinancialProfile, InvoicingProfile } from '@openbooks/schema'
import { capWipSources, effectiveWipPolicy, priceWipSource, sourceLinePrebillingReason } from './wip-billing-policy'

const profile = (patch: Partial<FinancialProfile> = {}): FinancialProfile => ({
  invoicedToDate: { docKinds: ['customer_invoice'], creditKinds: ['customer_credit'] },
  actualCost: { source: 'account_types', accountTypes: ['expense', 'cogs'] },
  laborCost: { source: 'time_rate' },
  overhead: { method: 'none' },
  committedCost: { docKinds: ['purchase_order'], statuses: ['approved'] },
  billableValue: {
    includeUnbilledTime: true,
    includeUnbilledCostLines: true,
    timeRate: 'bill_rate',
    costSourceKinds: ['vendor_bill'],
    costSourceStatuses: ['posted'],
  },
  costBudget: { source: 'wbs_estimates' },
  totalPrice: { method: 'billable_value' },
  couldBeInvoiced: { formula: 'unbilled_billable' },
  totalCost: { components: ['actual_cost', 'labor_cost'] },
  layout: [],
  ...patch,
})

const source = {
  sourceType: 'time_entry' as const,
  sourceDate: '2026-06-15',
  documentKind: null,
  documentStatus: null,
  directCostAmount: '200',
  nativeBillAmount: '350',
  quantity: '4',
}

test('WIP project policy admits only standard source-line billing procedures', () => {
  const standard: InvoicingProfile = { billingProcedure: 'standard', allowedBases: ['time_selection'], defaultBasis: 'time_selection', lineBuilder: 'tm_actual', revenueAccount: 'item_income', recognition: 'as_invoiced' }
  assert.equal(sourceLinePrebillingReason(standard), null)
  assert.match(sourceLinePrebillingReason({ ...standard, lineBuilder: 'milestone' })!, /milestones or draws/)
  assert.match(sourceLinePrebillingReason({ ...standard, billingProcedure: 'application_for_payment', lineBuilder: 'draw' })!, /applications for payment/)
})

test('WIP pricing resolves the financial profile effective on each source date', () => {
  const old = profile()
  const current = profile({ billableValue: { ...profile().billableValue, timeRate: 'cost_times_markup' } })
  const versions = [
    { id: 'new', effectiveFrom: '2026-07-01', effectiveTo: null, financialProfile: current },
    { id: 'old', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', financialProfile: old },
  ]
  assert.equal(effectiveWipPolicy(versions, old, '2026-06-15').id, 'old')
  assert.equal(effectiveWipPolicy(versions, old, '2026-07-15').id, 'new')
})

test('Cost-Plus WIP applies project markup and configured statistical overhead', () => {
  const configured = profile({
    billableValue: { ...profile().billableValue, timeRate: 'cost_times_markup' },
    overhead: { method: 'percent_of_labor', ratePercent: 12.5 },
    totalCost: { components: ['labor_cost', 'overhead'] },
    totalPrice: { method: 'cost_plus', defaultMarkupPercent: 15 },
  })
  const priced = priceWipSource(configured, source, '0')
  assert.equal(priced.billAmount, '230.0000')
  assert.equal(priced.overheadAmount, '25.0000')
  assert.equal(priced.loadedCostAmount, '225.0000')
})

test('WIP source kinds, lifecycle states, and inclusion switches are enforced', () => {
  const document = { ...source, sourceType: 'document_line' as const, documentKind: 'expense_report', documentStatus: 'posted' }
  assert.equal(priceWipSource(profile(), document, '0').eligible, false)
  assert.equal(priceWipSource(profile({ billableValue: { ...profile().billableValue, includeUnbilledTime: false } }), source, '0').eligible, false)
  const allowed = profile({ billableValue: { ...profile().billableValue, costSourceKinds: ['expense_report'] } })
  assert.equal(priceWipSource(allowed, document, '0').eligible, true)
})

test('not-to-exceed capacity deterministically caps the final eligible source', () => {
  assert.deepEqual(capWipSources([
    { id: 'a', billAmount: '70' },
    { id: 'b', billAmount: '50' },
  ], '100').map(({ id, cappedBillAmount }) => ({ id, cappedBillAmount })), [
    { id: 'a', cappedBillAmount: '70.0000' },
    { id: 'b', cappedBillAmount: '30.0000' },
  ])
})
