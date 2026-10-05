import assert from 'node:assert/strict'
import test from 'node:test'

const { budgetLineStatus, exactBudgetVariance } = await import('./health-data.ts')
const { ANALYTICS_CONFIG } = await import('./config-spec.ts')

// The organization's own tolerance bands, read from the threshold spec —
// never the starting percentages restated here.
const SPEC = ANALYTICS_CONFIG.financialHealth.defaults
const TOLERANCE = {
  onTrack: SPEC.budgetOnTrackPercent as number,
  watch: SPEC.budgetWatchPercent as number,
}

/**
 * Budget variance flags kept the direction. A revenue shortfall
 * is a miss, not overspend — it must read "under", never "over"/OVER
 * BUDGET — while a genuine cost overrun keeps "over".
 */
test('a revenue shortfall beyond tolerance reads under, not over', () => {
  // Billed 1,171,788 against 1,210,982: -3.2%... within tolerance is
  // on-track; push the miss beyond 25% and the status must stay on the
  // revenue side of the vocabulary.
  assert.equal(budgetLineStatus('income', '-390000', '1210982', TOLERANCE), 'under')
  assert.equal(exactBudgetVariance('900719925474099.00', '900719925474099.01').variance, '0.0100')
  assert.equal(budgetLineStatus('income_other', '-500', '1000', TOLERANCE), 'under')
})

test('a cost overrun beyond tolerance still reads over', () => {
  assert.equal(budgetLineStatus('expense', '40000', '100000', TOLERANCE), 'over')
  assert.equal(budgetLineStatus('cogs', '30000', '100000', TOLERANCE), 'over')
})

test('favorable and near lines stay on-track, the middle band stays watch', () => {
  assert.equal(budgetLineStatus('income', '5000', '100000', TOLERANCE), 'on-track')
  assert.equal(budgetLineStatus('expense', '-5000', '100000', TOLERANCE), 'on-track')
  assert.equal(budgetLineStatus('expense', '4600', '100000', TOLERANCE), 'on-track')
  assert.equal(budgetLineStatus('income', '-20000', '100000', TOLERANCE), 'watch')
  assert.equal(budgetLineStatus('expense', '20000', '100000', TOLERANCE), 'watch')
  assert.equal(budgetLineStatus('income', '0', '0', TOLERANCE), 'no-budget')
})

test('a line exactly on a band edge keeps the nearer status', () => {
  // 7% against a 7% on-track band stays on-track, and 7004/100000 (0.07004)
  // reads watch: a 4dp-rounded ratio would print 0.0700 and misgrade it as
  // on-track, so the edges cross-multiply with no intermediate ratio.
  assert.equal(budgetLineStatus('expense', '7000', '100000', { onTrack: 7, watch: 25 }), 'on-track')
  assert.equal(budgetLineStatus('expense', '7004', '100000', { onTrack: 7, watch: 25 }), 'watch')
  assert.equal(budgetLineStatus('expense', '25000', '100000', { onTrack: 7, watch: 25 }), 'watch')
  assert.equal(budgetLineStatus('expense', '25010', '100000', { onTrack: 7, watch: 25 }), 'over')
  assert.equal(budgetLineStatus('income', '-25000', '100000', { onTrack: 7, watch: 25 }), 'watch')
})

test('the tolerance bands come from configuration, not fixed percentages', () => {
  // An 8% cost overrun is on-track under the starting 10%/25% bands but
  // watch under a stricter 5%/15% organization policy — the same variance
  // must grade differently when the organization says so.
  assert.equal(budgetLineStatus('expense', '8000', '100000', TOLERANCE), 'on-track')
  assert.equal(budgetLineStatus('expense', '8000', '100000', { onTrack: 5, watch: 15 }), 'watch')
  assert.equal(budgetLineStatus('expense', '20000', '100000', { onTrack: 5, watch: 15 }), 'over')
  assert.equal(budgetLineStatus('income', '-20000', '100000', { onTrack: 5, watch: 15 }), 'under')
})
