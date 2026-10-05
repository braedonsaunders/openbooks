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

test('a save carrying the defaults passes and keeps every scoring default', () => {
  const cleaned = cleanConfigValues('customerIntelligence', fullSave())
  assert.equal(cleaned.healthWeightRecency, 25)
  assert.equal(cleaned.healthWeightPayment, 20)
  assert.equal(cleaned.gradeAPlus, 90)
  assert.equal(cleaned.recencyGoodDays, 30)
  assert.equal(cleaned.churnHighDays, 120)
  assert.equal(cleaned.tierPlatinumPct, 10)
  assert.equal(cleaned.concentrationCriticalShare, 25)
  assert.equal(cleaned.profitHighMargin, 40)
  assert.equal(cleaned.paymentDsoHighDays, 60)
  assert.equal(cleaned.growthYoyWindowMonths, 15)
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
