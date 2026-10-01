import assert from 'node:assert/strict'
import test from 'node:test'
import { importRowError } from './row-error'

test('business refusals and explicit database refusals retain their operator remedy', () => {
  assert.equal(importRowError(new Error('Period is closed — use an adjusting entry.')), 'Period is closed — use an adjusting entry.')
  const cause = Object.assign(new Error('Posted history is immutable — reverse this transaction.'), { code: 'P0001' })
  assert.equal(importRowError(new Error('Failed query: SECRET SQL', { cause })), cause.message)
  const controlled = Object.assign(new Error('Posted history is immutable — reverse this transaction.'), { code: '23514', routine: 'exec_stmt_raise' })
  assert.equal(importRowError(new Error('Failed query: SECRET SQL', { cause: controlled })), controlled.message)
})

test('driver failures expose a log reference without SQL or bound tenant data', () => {
  const cause = Object.assign(new Error('duplicate key value PRIVATE VALUE'), { code: '23505' })
  const prior = console.error
  const logs: unknown[][] = []
  console.error = (...values: unknown[]) => { logs.push(values) }
  try {
    const message = importRowError(new Error('Failed query: PRIVATE SQL', { cause }))
    assert.match(message, /inspect log reference [a-f0-9-]+, correct the cause, then retry/)
    assert.doesNotMatch(message, /PRIVATE|duplicate key|Failed query/)
    assert.equal(logs.length, 1)
  } finally { console.error = prior }
})
