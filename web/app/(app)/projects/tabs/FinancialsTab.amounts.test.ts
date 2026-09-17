import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { shouldHideFinancialLine, budgetAwareFinancialLayout } = (await tsImport('./FinancialsTab.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as {
  shouldHideFinancialLine: (hideWhenZero: boolean, value: string | number) => boolean
  budgetAwareFinancialLayout: (
    layout: Array<{ measure: string }>,
    costBudgetApplies: boolean,
    costBudget: string | number,
  ) => Array<{ measure: string }>
}

test('financial profiles hide decimal-string zero lines', () => {
  assert.equal(shouldHideFinancialLine(true, '0.0000'), true)
  assert.equal(shouldHideFinancialLine(true, '0.0001'), false)
  assert.equal(shouldHideFinancialLine(false, '0.0000'), false)
})

/**
 * F-t03-008: the work breakdown promises its estimates roll up to the cost
 * budget, but uncapped project types hid the cost-budget line entirely — so
 * $140,000 of estimates showed nowhere and gross profit read as the full
 * contract value. A positive budget now stays visible even when the ceiling
 * (remaining budget) does not apply.
 */
test('uncapped types still show a positive cost budget but no ceiling', () => {
  const layout = [{ measure: 'total_price' }, { measure: 'cost_budget' }, { measure: 'remaining_budget' }, { measure: 'gross_profit' }]
  assert.deepEqual(
    budgetAwareFinancialLayout(layout, false, '140000.0000').map((line) => line.measure),
    ['total_price', 'cost_budget', 'gross_profit'],
  )
  assert.deepEqual(
    budgetAwareFinancialLayout(layout, false, '0').map((line) => line.measure),
    ['total_price', 'gross_profit'],
  )
  assert.deepEqual(
    budgetAwareFinancialLayout(layout, true, '140000.0000').map((line) => line.measure),
    ['total_price', 'cost_budget', 'remaining_budget', 'gross_profit'],
  )
})
