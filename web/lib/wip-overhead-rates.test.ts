import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
import type { FinancialProfile } from '@openbooks/schema'
const { rateEngineOverhead } = await import('./wip-billing')

const profile = (patch: Partial<FinancialProfile> = {}): FinancialProfile => ({
  invoicedToDate: { docKinds: ['customer_invoice'], creditKinds: ['customer_credit'] },
  actualCost: { source: 'account_types', accountTypes: ['expense', 'cogs'] },
  laborCost: { source: 'time_rate' },
  overhead: { method: 'rate_engine', rateEngine: { rateSource: 'standard', hoursBasis: 'total_hours', scope: 'department', dimension: 'overhead' } },
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
  source_type: 'time_entry' as const,
  source_id: 'entry-1',
  time_entry_id: 'entry-1',
  document_line_id: null,
  source_document_id: null,
  source_date: '2026-06-15',
  description: 'Crew time',
  quantity: '2',
  unit: 'hours',
  item_id: null,
  income_account_id: null,
  tax_code_id: null,
  employee_party_id: null,
  time_type_id: null,
  department_id: 'dept-D',
  costing_basis: 'actual',
  document_kind: null,
  document_status: null,
  direct_cost_amount: '40.0000',
  native_bill_amount: '200.0000',
}

/**
 * Department specificity is per rate KIND — the same rule the postings use
 * (`overheadRateAppliesToTimeEntry`): a department percent row steps aside
 * only org-wide percent rows, never an org-wide per-hour row. Otherwise the
 * WIP loaded cost understates the burden the ledger will carry.
 */
test('WIP rate-engine overhead keeps org-wide rows of kinds the department does not set', () => {
  const rates = [
    { department_id: null, rate_kind: 'per_hour' as const, rate: '10', effective_from: '2026-01-01', effective_to: null },
    { department_id: 'dept-D', rate_kind: 'percent' as const, rate: '50', effective_from: '2026-01-01', effective_to: null },
  ]
  // 2h x 10 per-hour plus 50% of 40 direct cost.
  assert.equal(rateEngineOverhead(source, profile(), rates), '40.0000')
})

test('WIP rate-engine overhead lets a department row of the same kind win', () => {
  const rates = [
    { department_id: null, rate_kind: 'per_hour' as const, rate: '10', effective_from: '2026-01-01', effective_to: null },
    { department_id: 'dept-D', rate_kind: 'per_hour' as const, rate: '15', effective_from: '2026-01-01', effective_to: null },
  ]
  assert.equal(rateEngineOverhead(source, profile(), rates), '30.0000')
})

test('WIP rate-engine overhead falls back to org-wide rows without a department row', () => {
  const rates = [
    { department_id: null, rate_kind: 'per_hour' as const, rate: '10', effective_from: '2026-01-01', effective_to: null },
  ]
  assert.equal(rateEngineOverhead(source, profile(), rates), '20.0000')
})
