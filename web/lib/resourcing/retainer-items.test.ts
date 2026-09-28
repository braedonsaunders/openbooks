import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetainerItemEligible } from './retainer-items.ts'

test('retainer item eligibility follows the recognition rule', () => {
  assert.equal(isRetainerItemEligible('hours', { method: 'usage', isForecast: false }), true)
  assert.equal(isRetainerItemEligible('fees', { method: 'usage', isForecast: false }), false)
  assert.equal(isRetainerItemEligible('fees', { method: 'milestone', isForecast: false }), true)
  assert.equal(isRetainerItemEligible('hours', { method: 'milestone', isForecast: false }), false)
  assert.equal(isRetainerItemEligible('hours', { method: 'usage', isForecast: true }), false)
  assert.equal(isRetainerItemEligible('hours', null), false)
})
