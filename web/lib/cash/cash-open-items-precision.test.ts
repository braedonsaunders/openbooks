import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { add, cmp, formatMoney, normalizeMoney, sum } from '../../../engine/src/money.ts'

const cashRoot = join(import.meta.dirname)
const source = (name: string) => readFileSync(join(cashRoot, name), 'utf8')

test('cash open-item boundary keeps exact numeric(19,4) text', () => {
  const openItems = source('open-items.ts')
  assert.match(openItems, /remaining: normalizeMoneyValue\(String\(row\.remaining\)\)/)
  assert.doesNotMatch(openItems, /remaining:\s*Number\(row\.remaining\)/)

  const large = '9007199254740993.0000'
  assert.equal(normalizeMoney(large), large)
  assert.equal(add(large, '0.0001'), '9007199254740993.0001')
  assert.equal(formatMoney(large, 2), '9007199254740993.00')
  assert.equal(normalizeMoney('-0.125'), '-0.1250')
})

test('cash forecast consumers aggregate money with exact helpers', () => {
  const core = source('core.ts')
  const timeline = source('cash-position.ts')
  const ar = source('ar-position.ts')
  const ap = source('ap-position.ts')
  const analytics = readFileSync(join(cashRoot, '..', 'analytics', 'cashflow-data.ts'), 'utf8')

  for (const moduleSource of [core, timeline, ar, ap, analytics]) {
    assert.match(moduleSource, /sumMoney\(/)
    assert.match(moduleSource, /compareMoney\(/)
  }
  assert.match(core, /remaining: Money/)
  assert.match(timeline, /startingCash: string/)
  assert.match(ar, /outstanding: string/)
  assert.match(ap, /recommendedTotal: string/)
  assert.match(analytics, /startingCash: string/)
  assert.match(core, /pctCurrent: Money/)
  assert.match(timeline, /runwayWeeks: string \| null/)
  assert.match(analytics, /arCoverage: string \| null/)
  assert.doesNotMatch(analytics, /totalIn\s*-\s*totalOut/)
  assert.doesNotMatch(timeline, /Number\(divideMoney\(/)
  assert.doesNotMatch(analytics, /Number\(divideMoney\(/)
})

test('AP, AR, cash position, and analytics retain signed high-range balances', () => {
  const balances = ['9007199254740993.0000', '-0.1250', '0.0001']
  assert.equal(sum(balances), '9007199254740992.8751')
  assert.equal(add('9007199254740993.0000', '0.0001'), '9007199254740993.0001')
  assert.equal(cmp('9007199254740993.0000', '9007199254740992.9999'), 1)

  for (const name of ['ap-position.ts', 'ar-position.ts', 'cash-position.ts']) {
    const moduleSource = source(name)
    assert.doesNotMatch(moduleSource, /Math\.max\(0,\s*[^\n]*(?:outstanding|amount|remaining)/)
    assert.match(moduleSource, /subtractMoney\(/)
  }
})

test('subsidiary cash vendor picker scopes payable documents', () => {
  const cashPosition = source('cash-position.ts')
  assert.match(cashPosition, /d\.subsidiary_id\s+is null or d\.subsidiary_id = any\(/)
  assert.match(cashPosition, /subIds\.join\("[,]"\)/)
})

test('cash UI, assistant, and vitals preserve strings and bound chart projections', () => {
  const root = join(cashRoot, '..', '..')
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const format = read('app/(app)/analytics/_ui/format.ts')
  const charts = read('app/(app)/analytics/_ui/charts.tsx')
  const timeline = read('app/(app)/analytics/_ui/CashTimeline.tsx')
  const flyout = read('app/(app)/analytics/_ui/CashWeekFlyout.tsx')
  const config = read('lib/analytics/config.ts')
  const assistant = read('lib/assistant/tools-analytics.ts')
  const vitals = read('lib/application/vitals.ts')

  assert.match(format, /MoneyValue/)
  assert.match(format, /toChartNumber\(value: string\)/)
  assert.match(format, /boundChartNumber\(value: number\)/)
  assert.match(charts, /cashBridgeOption\(startCash: string/)
  assert.match(charts, /const exactValues = \[startCash, inflows, moneyNeg\(outflows\), end\]/)
  assert.match(timeline, /weeklyCap: string/)
  assert.match(flyout, /sumMoney\(/)
  assert.match(config, /weeklyApCap: "0\.0000"/)
  assert.match(config, /normalizeMoney\(/)
  assert.match(assistant, /startingCash: r\.startingCash/)
  assert.doesNotMatch(assistant, /startingCash:\s*num\(/)
  assert.match(vitals, /normalizeMoneyValue\(/)
})
