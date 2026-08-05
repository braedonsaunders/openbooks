import assert from 'node:assert/strict'
import test from 'node:test'
import { appKeyFromWidgetId, appWidgetId, isAppWidgetId } from './surfaces'

test('app widget IDs round-trip without colliding with other widget IDs', () => {
  assert.equal(appWidgetId('expense-insights'), 'app:expense-insights')
  assert.equal(appKeyFromWidgetId('app:expense-insights'), 'expense-insights')
  assert.equal(isAppWidgetId('app:expense-insights'), true)
  assert.equal(isAppWidgetId('kpi-cash-balance'), false)
  assert.equal(isAppWidgetId('app:../other'), false)
})

test('app widget IDs reject invalid app keys', () => {
  assert.throws(() => appWidgetId('Expense Insights'), /invalid app key/)
})
