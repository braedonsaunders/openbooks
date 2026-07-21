import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateExact, buildExternalPayrollVarianceLines, externalPayrollClearingMatches } from './payroll-cost.ts'
import { sum } from './money.ts'

test('largest-remainder payroll allocation preserves positive and negative totals exactly', () => {
  const positive = allocateExact('100.0000', ['1.0000', '1.0000', '1.0000'])
  assert.deepEqual(positive, ['33.3334', '33.3333', '33.3333'])
  assert.equal(sum(positive), '100.0000')
  const negative = allocateExact('-10.0001', ['2.0000', '1.0000'])
  assert.equal(sum(negative), '-10.0001')
})

test('payroll allocation rejects empty and negative weights', () => {
  assert.throws(() => allocateExact('10', ['0', '0']), /positive/)
  assert.throws(() => allocateExact('10', ['1', '-1']), /negative/)
})

test('external payroll variance preserves project dimensions and balances exactly', () => {
  const lines = buildExternalPayrollVarianceLines([
    { projectId: 'P1', departmentId: 'D1', locationId: 'L1', amount: '25.1234' },
    { projectId: 'P2', departmentId: null, locationId: 'L2', amount: '-5.1233' },
  ], 'WIP', 'CLEARING')
  assert.equal(lines.length, 3)
  assert.deepEqual(lines[0], {
    accountId: 'WIP', amount: '25.1234', projectId: 'P1', departmentId: 'D1', locationId: 'L1',
    memo: 'External payroll actual-to-standard variance',
  })
  assert.equal(lines[2]!.accountId, 'CLEARING')
  assert.equal(lines[2]!.amount, '-20.0001')
  assert.equal(sum(lines.map((line) => line.amount)), '0.0000')
})

test('zero variance posts nothing and clearing proof compares numeric(19,4) exactly', () => {
  assert.deepEqual(buildExternalPayrollVarianceLines([
    { projectId: 'P1', departmentId: null, locationId: null, amount: '0.0000' },
  ], 'WIP', 'CLEARING'), [])
  assert.equal(externalPayrollClearingMatches('2875', '2875.0000'), true)
  assert.equal(externalPayrollClearingMatches('2875.0001', '2875.0000'), false)
})
