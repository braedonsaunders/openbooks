import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { customerStrings, type GradeLadder } from './customer-strings'

const messages = {
  analytics: JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'messages', 'en', 'analytics.json'), 'utf8')),
}
const t = createTranslator({ locale: 'en', messages, namespace: 'analytics' })
const strings = customerStrings(
  (key: string, values?: Record<string, string | number>) =>
    t(key, values as Record<string, string | number | Date>),
  'en',
)

// The health grade and the intelligence grade share ONE ladder from the
// scoring config. A score of 82 used to read B+ on the old 40/55/70/85
// intelligence scale while health called 82 an A; both now read the same
// configured cut-offs.
const LADDER: GradeLadder = { aPlus: 90, a: 80, b: 70, c: 60, d: 50 }

test('the intelligence grade reads the shared ladder, not its own scale', () => {
  assert.equal(strings.intelligenceScore(95, LADDER).grade, 'A+')
  assert.equal(strings.intelligenceScore(82, LADDER).grade, 'A')
  assert.equal(strings.intelligenceScore(70, LADDER).grade, 'B')
  assert.equal(strings.intelligenceScore(60, LADDER).grade, 'C')
  assert.equal(strings.intelligenceScore(55, LADDER).grade, 'D')
  assert.equal(strings.intelligenceScore(20, LADDER).grade, 'F')
})

test('the ladder follows configuration, not literals', () => {
  const custom: GradeLadder = { aPlus: 80, a: 70, b: 60, c: 50, d: 40 }
  assert.equal(strings.intelligenceScore(82, custom).grade, 'A+')
  assert.equal(strings.intelligenceScore(82, custom).label, 'Excellent')
  assert.equal(strings.intelligenceScore(45, custom).grade, 'D')
})

test('a broken weight group is refused by name with the remedy', () => {
  const message = strings.scoringWeightsInvalid('healthWeightRecency, healthWeightPayment', 100, 94)
  assert.ok(message.includes('healthWeightRecency'))
  assert.ok(message.includes('94'))
  assert.ok(/Configuration/i.test(message))
})
