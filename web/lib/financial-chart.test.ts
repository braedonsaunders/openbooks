import assert from 'node:assert/strict'
import test from 'node:test'
import { financialChartCoordinate, financialChartPercent, MAX_FINANCIAL_CHART_COORDINATE } from './financial-chart.ts'

test('financial chart coordinates clamp huge decimals without changing source money', () => {
  assert.equal(financialChartCoordinate('90071992547409.93'), MAX_FINANCIAL_CHART_COORDINATE)
  assert.equal(financialChartCoordinate('9007199254740993'), MAX_FINANCIAL_CHART_COORDINATE)
  assert.equal(financialChartCoordinate('-9007199254740993'), -MAX_FINANCIAL_CHART_COORDINATE)
})

test('financial chart ratios use exact decimal inputs and bounded coordinates', () => {
  assert.equal(financialChartPercent('90071992547409.93', '180143985094819.86'), 50)
  assert.equal(financialChartPercent('90071992547409.93', '1.0000'), 100)
})
