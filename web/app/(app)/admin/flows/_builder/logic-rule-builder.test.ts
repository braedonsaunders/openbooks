import assert from 'node:assert/strict'
import test from 'node:test'
import type { LogicRule } from '@openbooks/forms-core'
import { makeGroup } from './logic-rule-builder.ts'

const child = (field: string): LogicRule => ({ op: 'isSet', field })

test('negating a three-child AND group preserves the AND group and every child', () => {
  const children = [child('one'), child('two'), child('three')]

  assert.deepEqual(makeGroup('not', children, 'fallback', 'and'), {
    op: 'not',
    rule: { op: 'and', rules: children },
  })
})

test('negating a three-child OR group preserves the OR group and every child', () => {
  const children = [child('one'), child('two'), child('three')]

  assert.deepEqual(makeGroup('not', children, 'fallback', 'or'), {
    op: 'not',
    rule: { op: 'or', rules: children },
  })
})

test('negating an empty group keeps its source combinator', () => {
  assert.deepEqual(makeGroup('not', [], 'fallback', 'and'), {
    op: 'not',
    rule: { op: 'and', rules: [] },
  })
  assert.deepEqual(makeGroup('not', [], 'fallback', 'or'), {
    op: 'not',
    rule: { op: 'or', rules: [] },
  })
})

test('negating a one-child group unwraps the child', () => {
  const onlyChild = child('only')

  assert.deepEqual(makeGroup('not', [onlyChild], 'fallback', 'and'), {
    op: 'not',
    rule: onlyChild,
  })
  assert.deepEqual(makeGroup('not', [onlyChild], 'fallback', 'or'), {
    op: 'not',
    rule: onlyChild,
  })
})

test('creating a NOT group without a source group uses the fallback leaf', () => {
  assert.deepEqual(makeGroup('not', [], 'fallback'), {
    op: 'not',
    rule: { op: 'isSet', field: 'fallback' },
  })
})
