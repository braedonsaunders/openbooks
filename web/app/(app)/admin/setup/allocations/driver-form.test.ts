import assert from 'node:assert/strict'
import test from 'node:test'
import {
  driverConfigFromForm,
  driverPayloadFromForm,
  formFromDriver,
  newDriverForm,
  valuePayloadFromForm,
} from './driver-form.ts'

test('config shaping keeps only the active source kind fields', () => {
  const base = { ...newDriverForm(), unit: ' FTE ', accountIds: ['a1'] }
  assert.deepEqual(driverConfigFromForm({ ...base, sourceKind: 'statistical_journal' }), {
    unit: 'FTE',
    accountIds: ['a1'],
  })
  assert.deepEqual(
    driverConfigFromForm({ ...base, sourceKind: 'gl_activity', accountScopeAny: true }),
    { accountScope: { kind: 'any' } },
  )
  assert.deepEqual(
    driverConfigFromForm({ ...base, sourceKind: 'gl_balance', accountScopeAny: false }),
    { accountScope: { kind: 'accounts', accountIds: ['a1'] } },
  )
  assert.deepEqual(driverConfigFromForm({ ...base, sourceKind: 'manual' }), {})
  assert.deepEqual(driverConfigFromForm({ ...base, sourceKind: 'native_measure', measure: 'revenue' }), {
    measure: 'revenue',
  })
})

test('driver payload trims text and nulls blanks', () => {
  const payload = driverPayloadFromForm({
    ...newDriverForm(),
    key: 'fte',
    name: ' FTE ',
    description: '  ',
    unit: '',
  })
  assert.equal(payload.key, 'fte')
  assert.equal(payload.name, 'FTE')
  assert.equal(payload.description, null)
  assert.equal(payload.unit, null)
})

test('edit rehydrates the stored config per source kind', () => {
  const gl = formFromDriver({
    key: 'g',
    name: 'G',
    description: null,
    unit: null,
    dimension: 'department',
    sourceKind: 'gl_activity',
    isActive: true,
    config: { accountScope: { kind: 'accounts', accountIds: ['a1', 42] } },
  })
  assert.equal(gl.accountScopeAny, false)
  assert.deepEqual(gl.accountIds, ['a1'])

  const any = formFromDriver({
    key: 'h',
    name: 'H',
    description: null,
    unit: 'FTE',
    dimension: 'department',
    sourceKind: 'statistical_journal',
    isActive: true,
    config: { unit: 'HC' },
  })
  assert.equal(any.unit, 'HC')
  assert.deepEqual(any.accountIds, [])
})

test('value payload preserves exact decimal text', () => {
  const precise = '9007199254740993.1234'
  const payload = valuePayloadFromForm({
    dimensionValueId: 'd1',
    effectiveFrom: '2026-01-01',
    effectiveTo: '',
    value: ` ${precise} `,
    note: '',
  })
  assert.equal(payload.value, precise)
  assert.equal(payload.effectiveTo, null)
  assert.equal(payload.note, null)
})
