import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCriteria, validateOutcome } from './banking-rules-validate.ts'

const accountId = '019fba6a-97b3-7fe8-8d9d-71bdbfd8b820'

test('criteria accept only the canonical versioned condition tree', () => {
  assert.equal(validateCriteria({ descriptionContains: 'rent' }).ok, false)
  assert.equal(validateCriteria({ version: 1, match: { combinator: 'and', rules: [] } }).ok, false)
  assert.equal(validateCriteria({ version: 2, match: { combinator: 'and', rules: [] } }).ok, false)
  assert.equal(
    validateCriteria({
      version: 2,
      match: { combinator: 'and', rules: [{ field: 'anyText', op: 'contains', value: 'rent' }] },
      accountScope: [accountId],
    }).ok,
    true,
  )
})

test('criteria reject malformed operators, values, IDs, and calendar dates', () => {
  const criteria = (condition: Record<string, unknown>) => ({
    version: 2,
    match: { combinator: 'and', rules: [condition] },
  })
  assert.equal(validateCriteria(criteria({ field: 'amount', op: 'contains', value: 4 })).ok, false)
  assert.equal(validateCriteria(criteria({ field: 'source', op: 'equals', value: '' })).ok, false)
  assert.equal(validateCriteria(criteria({ field: 'date', op: 'on', value: '2026-02-31' })).ok, false)
  assert.equal(validateCriteria({ ...criteria({ field: 'flow', op: 'is', value: 'in' }), accountScope: ['bad-id'] }).ok, false)
})

test('outcomes accept only canonical exclude or versioned split allocation', () => {
  assert.deepEqual(validateOutcome({ action: 'exclude' }), { ok: true, value: { action: 'exclude' } })
  assert.equal(validateOutcome({ action: 'categorize', accountId }).ok, false)
  assert.equal(
    validateOutcome({
      action: 'categorize',
      version: 2,
      mode: 'suggest',
      lines: [{ accountId, portion: { kind: 'remainder' } }],
    }).ok,
    true,
  )
})

test('outcomes reject silent defaults and malformed dimensions', () => {
  const outcome = (line: Record<string, unknown>) => ({
    action: 'categorize',
    version: 2,
    mode: 'auto',
    lines: [line],
  })
  assert.equal(validateOutcome(outcome({ accountId, portion: {} })).ok, false)
  assert.equal(validateOutcome(outcome({ accountId, portion: { kind: 'fixed', value: 0 } })).ok, false)
  assert.equal(validateOutcome(outcome({ accountId, portion: { kind: 'remainder' }, projectId: 'bad-id' })).ok, false)
  assert.equal(validateOutcome({ ...outcome({ accountId, portion: { kind: 'remainder' } }), mode: 'automatic' }).ok, false)
})
