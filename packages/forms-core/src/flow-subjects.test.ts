// Run with: node --import tsx --test packages/forms-core/src/flow-subjects.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowFieldValueError, type FlowFieldDef } from './index'

const def = (key: string, type: FlowFieldDef['type'], options?: FlowFieldDef['options']): FlowFieldDef => ({
  key,
  label: key,
  type,
  ...(options ? { options } : {}),
})

test('null and undefined clear any field', () => {
  for (const type of ['text', 'number', 'bool', 'date', 'enum', 'user'] as const) {
    assert.equal(flowFieldValueError(def('f', type), null), null)
    assert.equal(flowFieldValueError(def('f', type), undefined), null)
  }
})

test('text and user fields take strings only', () => {
  assert.equal(flowFieldValueError(def('memo', 'text'), 'hello'), null)
  assert.ok(flowFieldValueError(def('memo', 'text'), 42)?.includes('"memo"'))
  assert.equal(flowFieldValueError(def('owner', 'user'), 'user-1'), null)
  assert.ok(flowFieldValueError(def('owner', 'user'), 42))
})

test('number fields take finite numbers only', () => {
  assert.equal(flowFieldValueError(def('total', 'number'), 42.5), null)
  assert.ok(flowFieldValueError(def('total', 'number'), '42.5'), 'numeric strings are refused, not coerced')
  assert.ok(flowFieldValueError(def('total', 'number'), NaN))
  assert.ok(flowFieldValueError(def('total', 'number'), Infinity))
})

test('bool fields take booleans only', () => {
  assert.equal(flowFieldValueError(def('flag', 'bool'), true), null)
  assert.ok(flowFieldValueError(def('flag', 'bool'), 1), '1/0 are refused, not coerced')
  assert.ok(flowFieldValueError(def('flag', 'bool'), 'true'))
})

test('date fields take calendar-date or datetime shapes', () => {
  assert.equal(flowFieldValueError(def('dueDate', 'date'), '2026-05-01'), null)
  assert.equal(flowFieldValueError(def('dueDate', 'date'), '2026-05-01T09:30'), null)
  assert.equal(flowFieldValueError(def('dueDate', 'date'), new Date()), null)
  const refusal = flowFieldValueError(def('dueDate', 'date'), 'not-a-date')
  assert.ok(refusal?.includes('"dueDate"') && refusal.includes('YYYY-MM-DD'))
  assert.ok(flowFieldValueError(def('dueDate', 'date'), 20260501))
})

test('closed enum fields take only listed values', () => {
  const status = def('status', 'enum', [{ value: 'draft', label: 'Draft' }, { value: 'approved', label: 'Approved' }])
  assert.equal(flowFieldValueError(status, 'draft'), null)
  const refusal = flowFieldValueError(status, 'posted')
  assert.ok(refusal?.includes('"status"') && refusal.includes('draft'))
  assert.ok(flowFieldValueError(status, 42), 'non-strings are refused as text')
})

test('open enum fields take any string', () => {
  assert.equal(flowFieldValueError(def('currency', 'enum'), 'USD'), null)
  assert.ok(flowFieldValueError(def('currency', 'enum'), 42))
})
