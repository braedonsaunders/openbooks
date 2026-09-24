import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSurveyAuthorPayload, parseMinGroupSize, splitOptions } from './authoring'

// F3-68: the anonymity threshold must refuse by name on unparseable input —
// a silent fallback to 5 would move the anonymity threshold under the
// operator. The dialog shows the minGroupInvalid catalog string and posts
// nothing when the build refuses.
test('parseMinGroupSize accepts whole numbers from 2 to 1000', () => {
  assert.equal(parseMinGroupSize('5'), 5)
  assert.equal(parseMinGroupSize('2'), 2)
  assert.equal(parseMinGroupSize('1000'), 1000)
  assert.equal(parseMinGroupSize('  7  '), 7)
})

test('parseMinGroupSize refuses blank, non-numeric, fractional, and out-of-range input', () => {
  assert.equal(parseMinGroupSize(''), null)
  assert.equal(parseMinGroupSize('   '), null)
  assert.equal(parseMinGroupSize('abc'), null)
  assert.equal(parseMinGroupSize('5 people'), null)
  assert.equal(parseMinGroupSize('2.5'), null)
  assert.equal(parseMinGroupSize('1'), null)
  assert.equal(parseMinGroupSize('0'), null)
  assert.equal(parseMinGroupSize('-3'), null)
  assert.equal(parseMinGroupSize('1001'), null)
  assert.equal(parseMinGroupSize('NaN'), null)
  assert.equal(parseMinGroupSize('Infinity'), null)
})

test('the author payload refuses an unparseable group size instead of defaulting', () => {
  const base = {
    name: 'Pulse',
    kind: 'pulse',
    anonymity: 'anonymous',
    questions: [{ kind: 'scale', prompt: 'How are you?', options: '', driverKey: '' }],
  }
  const refused = buildSurveyAuthorPayload({ ...base, minGroup: 'abc' })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.error : null, 'minGroupInvalid')

  const blank = buildSurveyAuthorPayload({ ...base, minGroup: '' })
  assert.equal(blank.ok, false)

  const accepted = buildSurveyAuthorPayload({ ...base, minGroup: '5' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.ok === true ? accepted.body.minGroupSize : null, 5)
})

// F3-54: the options editor is multi-line (one choice per line), so the
// payload carries every line — never just the first.
test('splitOptions splits lines and drops blanks', () => {
  assert.deepEqual(splitOptions('red\ngreen\nblue'), ['red', 'green', 'blue'])
  assert.deepEqual(splitOptions('red\n\n  \ngreen  '), ['red', 'green'])
  assert.deepEqual(splitOptions(''), [])
  assert.deepEqual(splitOptions('only'), ['only'])
})

test('the author payload posts every option line for choice questions', () => {
  const built = buildSurveyAuthorPayload({
    name: 'Pulse',
    kind: 'pulse',
    anonymity: 'anonymous',
    minGroup: '5',
    questions: [{ kind: 'single', prompt: 'Pick', options: 'red\ngreen\nblue', driverKey: '' }],
  })
  assert.equal(built.ok, true)
  assert.deepEqual(built.ok === true ? built.body.questions[0]?.options : null, ['red', 'green', 'blue'])
})
