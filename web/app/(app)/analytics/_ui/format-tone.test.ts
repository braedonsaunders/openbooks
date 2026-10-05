import assert from 'node:assert/strict'
import test from 'node:test'

const { scoreTone } = await import('./format.ts')

// Gauge tones follow the caller's own bands — never a fixed 80/60/40. A
// strict organization grading excellent only at 90 reads an 85 as good,
// where the old fixed cut-offs would have called it excellent.
test('scoreTone grades against the caller bands', () => {
  const strict = { excellent: 90, good: 70, average: 50 }
  assert.equal(scoreTone(85, strict).hex, '#0ea5b7')
  assert.equal(scoreTone(90, strict).hex, '#10b981')
  assert.equal(scoreTone(49, strict).hex, '#ef4444')
  const lax = { excellent: 80, good: 60, average: 40 }
  assert.equal(scoreTone(85, lax).hex, '#10b981')
  assert.equal(scoreTone(39, lax).hex, '#ef4444')
})
