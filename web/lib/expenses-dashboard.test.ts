import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// expenses-dashboard.ts is a server-only module. The marker only gates RSC
// bundling, so replace it with an empty module for this pure aggregation test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { aggregateExpenseSummary } = await import('./expenses-dashboard.ts')

test('expense summary preserves fractional and negative currency values', () => {
  const summary = aggregateExpenseSummary({
    topSpenderTotals: ['10.49', '-0.25'],
    vendorBillTotals: ['-12.75', '0.50'],
    categoryIncreaseTotal: '-0.01',
    highSpenderCount: 1,
  })

  assert.deepEqual(summary, {
    expenseReportTotal: '10.2400',
    vendorBillTotal: '-12.2500',
    highSpenderCount: 1,
    categoryIncreaseTotal: '-0.0100',
  })
})

test('expense summary sums values beyond Number safe integer exactly', () => {
  const summary = aggregateExpenseSummary({
    // Each value fits the ledger column; their aggregate exceeds 2^53.
    topSpenderTotals: Array.from({ length: 10 }, () => '1000000000000000.0000'),
    vendorBillTotals: ['9007199254740991.1234', '0.8766'],
    categoryIncreaseTotal: '9007199254740992.0000',
    highSpenderCount: 0,
  })

  assert.equal(summary.expenseReportTotal, '10000000000000000.0000')
  assert.equal(summary.vendorBillTotal, '9007199254740992.0000')
  assert.equal(summary.categoryIncreaseTotal, '9007199254740992.0000')
})
