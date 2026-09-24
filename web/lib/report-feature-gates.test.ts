import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_PATH_FEATURE_GATES, savedReportPathVisible } from './report-feature-gates'

// F1T-16: the hub's saved-views filter derives from the route-gate registry,
// never a hand list. The reported hole was a saved /reports/true-cost view
// showing with Projects off; lot-recall/inventory was missing the same way.
const ALL_ON = { projects: true, budgets: true, orders: true, inventory: true }

test('a saved true-cost view hides with Projects off and shows with it on', () => {
  assert.equal(savedReportPathVisible('/reports/true-cost', { ...ALL_ON, projects: false }), false)
  assert.equal(savedReportPathVisible('/reports/true-cost', ALL_ON), true)
})

test('every registry entry hides its route when its feature is off', () => {
  for (const { prefix, feature } of REPORT_PATH_FEATURE_GATES) {
    assert.equal(
      savedReportPathVisible(prefix, { ...ALL_ON, [feature]: false }),
      false,
      `${prefix} must hide with ${feature} off`,
    )
    assert.equal(savedReportPathVisible(prefix, ALL_ON), true, `${prefix} must show with ${feature} on`)
  }
})

test('an unrelated feature never hides a gated route', () => {
  assert.equal(savedReportPathVisible('/reports/true-cost', { ...ALL_ON, budgets: false }), true)
  assert.equal(savedReportPathVisible('/reports/orders', { ...ALL_ON, projects: false }), true)
})

test('ungated report paths always stay visible', () => {
  for (const path of ['/reports/pnl', '/reports/partners', '/reports/statements/abc', '/reports/custom/run/def']) {
    assert.equal(savedReportPathVisible(path, { projects: false, budgets: false, orders: false, inventory: false }), true)
  }
})

test('matching is segment-boundary, so siblings of gated routes stay visible', () => {
  const off = { projects: false, budgets: false, orders: false, inventory: false }
  assert.equal(savedReportPathVisible('/reports/budgetary', off), true)
  assert.equal(savedReportPathVisible('/reports/true-costume', off), true)
  assert.equal(savedReportPathVisible('/reports/true-cost', off), false)
})
