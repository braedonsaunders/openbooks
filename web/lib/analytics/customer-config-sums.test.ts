import assert from 'node:assert/strict'
import test from 'node:test'
import { ANALYTICS_CONFIG, cleanConfigValues, mergeConfig } from './config-spec'

// The customer scoring model lives in the config spec: every weight, band
// and cut-off is an editable threshold with today's value as its default.
// A save whose weights do not sum to 100 must be refused by name — partial
// weights would silently rescale every health and intelligence grade.

function fullSave(overrides: Record<string, number | string> = {}) {
  return { ...ANALYTICS_CONFIG.customerIntelligence.defaults, ...overrides }
}

test('a save carrying the defaults passes with whole weight groups and ordered ladders', () => {
  const spec = ANALYTICS_CONFIG.customerIntelligence
  const cleaned = cleanConfigValues('customerIntelligence', fullSave())
  // The save round-trips every default: nothing dropped, nothing invented.
  assert.deepEqual(cleaned, fullSave())
  const byKey = cleaned as Record<string, number>
  for (const group of spec.sumsTo ?? []) {
    const actual = group.keys.reduce((sum, key) => sum + (byKey[key] ?? 0), 0)
    assert.equal(actual, group.total)
  }
  for (const ladder of spec.ordered ?? []) {
    const values = ladder.map((key) => byKey[key] ?? Number.NaN)
    for (let i = 1; i < values.length; i++) assert.ok(values[i]! > values[i - 1]!)
  }
})

test('health weights that do not sum to 100 are refused by name', () => {
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ healthWeightRecency: 24 })),
    (error: unknown) =>
      error instanceof Error &&
      /healthWeightRecency/.test(error.message) &&
      /sum to 100/.test(error.message),
  )
})

test('intelligence weights that do not sum to 100 are refused by name', () => {
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ intelWeightPayment: 10 })),
    (error: unknown) => error instanceof Error && /intelWeightPayment/.test(error.message),
  )
})

test('an inverted grade ladder is refused so no grade is unreachable', () => {
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ gradeA: 70, gradeB: 70 })),
    (error: unknown) => error instanceof Error && /gradeB/.test(error.message),
  )
})

test('an inverted churn ladder is still refused', () => {
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ churnHighScore: 30 })),
    (error: unknown) => error instanceof Error && /churnHighScore/.test(error.message),
  )
})

test('a worse churn or payment band can never score less than a milder one', () => {
  // Inactivity days ascend low < medium < high, and every point and penalty
  // group ascends with severity — a save flipping any of them is refused.
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ churnMediumDays: 20 })),
    (error: unknown) => error instanceof Error && /churnMediumDays/.test(error.message),
  )
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ churnInactiveHighPoints: 5 })),
    (error: unknown) => error instanceof Error && /churnInactiveHighPoints/.test(error.message),
  )
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ churnSinglePoints: 10 })),
    (error: unknown) => error instanceof Error && /churnSinglePoints/.test(error.message),
  )
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ paymentDsoHighPenalty: 5 })),
    (error: unknown) => error instanceof Error && /paymentDsoHighPenalty/.test(error.message),
  )
  assert.throws(
    () => cleanConfigValues('customerIntelligence', fullSave({ concentrationHealthModerate: 20 })),
    (error: unknown) => error instanceof Error && /concentrationHealthModerate/.test(error.message),
  )
})

test('an unknown scoring key is refused', () => {
  assert.throws(
    () => cleanConfigValues('customerIntelligence', { ...fullSave(), noSuchKnob: 1 }),
    (error: unknown) => error instanceof Error && /noSuchKnob/.test(error.message),
  )
})

test('a tolerant read materializes every scoring default', () => {
  const merged = mergeConfig('customerIntelligence', null)
  for (const key of Object.keys(ANALYTICS_CONFIG.customerIntelligence.defaults)) {
    assert.ok(key in merged, `missing default for ${key}`)
  }
})
