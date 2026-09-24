import assert from 'node:assert/strict'
import test from 'node:test'
import { celebrationDetail, teamNudgeTexts, type PersonaTranslator } from './_persona-copy'

// F4T2-7: the persona surface built English copy by concatenation
// (`2 years`, `1 step(s)`). Every branch below must render through the
// dashboard.persona catalog — ICU plurals for counts, locale dates for
// days — so the stub translator records keys+params and the assertions pin
// the branch-to-key mapping, never an English sentence.
const calls: { key: string; params?: Record<string, string | number> }[] = []
const tp: PersonaTranslator = (key, params) => {
  calls.push({ key, params })
  return `${key}(${JSON.stringify(params)})`
}

test('a future start joins on the locale date', () => {
  calls.length = 0
  const detail = celebrationDetail('2026-02-01', '2026-01-05', 'en', tp)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.key, 'joinsOn')
  assert.ok(detail.includes('Feb 1, 2026'), 'the date renders in the operator locale')
})

test('a past start with full years uses the ICU plural count', () => {
  calls.length = 0
  const detail = celebrationDetail('2023-04-10', '2026-01-05', 'en', tp)
  assert.deepEqual(calls, [{ key: 'serviceYears', params: { years: 3 } }])
  assert.ok(detail.startsWith('serviceYears('), 'the count rides inside the catalog key, never a concatenated sentence')
})

test('a same-year past start falls back to the since date', () => {
  calls.length = 0
  celebrationDetail('2026-01-02', '2026-01-05', 'de', tp)
  assert.equal(calls[0]?.key, 'joinedSince')
  assert.deepEqual(Object.keys(calls[0]?.params ?? {}), ['date'])
})

test('nudges carry counts inside ICU params with stable targets', () => {
  calls.length = 0
  const nudges = teamNudgeTexts(2, 1, tp)
  assert.deepEqual(nudges, [
    { text: 'overdueSteps({"overdue":2})', href: '/hrm/processes' },
    { text: 'newJoiners({"joiners":1})', href: '/hrm' },
  ])
})

test('zero counts nudge nothing', () => {
  assert.deepEqual(teamNudgeTexts(0, 0, tp), [])
})
