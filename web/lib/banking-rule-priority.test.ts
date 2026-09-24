import assert from 'node:assert/strict'
import test from 'node:test'
import { bankRulePriority } from './banking-rule-priority.ts'

test('bank rule priority preserves zero and defaults only for blank input', () => {
  assert.equal(bankRulePriority('0'), 0)
  assert.equal(bankRulePriority(0), 0)
  assert.equal(bankRulePriority(''), 100)
  assert.equal(bankRulePriority(undefined), 100)
})
