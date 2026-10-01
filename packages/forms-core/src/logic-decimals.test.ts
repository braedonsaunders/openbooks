import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLogicRule, LogicEvaluationError } from './evaluator'
import type { LogicRule } from './schema'
import { logicRuleSchema } from './schema'

const compare = (op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne', actual: unknown, threshold: string | number) =>
  evaluateLogicRule({ op, field: 'amount', value: threshold } as LogicRule, { values: { amount: actual }, rows: {} })

test('ordered approval conditions distinguish adjacent exact amounts beyond double precision', () => {
  for (const sign of [1n, -1n]) {
    for (const units of [90071992547409910000n, 99999999999999999999n]) {
      const decimal = (value: bigint) => `${value / 10000n}.${(value < 0n ? -(value % 10000n) : value % 10000n).toString().padStart(4, '0')}`
      const lower = decimal(sign > 0n ? units : -units - 1n)
      const higher = decimal(sign > 0n ? units + 1n : -units)
      assert.equal(compare('lt', lower, higher), true, `${lower} < ${higher}`)
      assert.equal(compare('gt', higher, lower), true, `${higher} > ${lower}`)
      assert.equal(compare('gte', lower, higher), false)
      assert.equal(compare('lte', higher, lower), false)
      assert.equal(compare('gte', lower, lower), true)
      assert.equal(compare('lte', higher, higher), true)
    }
  }
})

test('numeric equality cannot round an exact decimal into a nearby numeric threshold', () => {
  assert.equal(compare('eq', '9007199254740992.0001', 9007199254740992), false)
  assert.equal(compare('ne', '9007199254740992.0001', 9007199254740992), true)
  assert.equal(compare('eq', '3.0000', 3), true)
  assert.equal(compare('gt', '1e-7', '0.00000009'), true)
  assert.equal(compare('gte', '-0.0000', 0), true)
})

test('unreadable nonempty comparison values raise an actionable refusal rather than becoming zero', () => {
  for (const value of ['1,234', 'CAD 100', 'NaN', '0x10', Infinity, {}, []]) {
    assert.throws(() => compare('lt', value, '100.00'), error =>
      error instanceof LogicEvaluationError && /Field "amount".*exact decimal.*correct the value or condition/.test(error.message))
  }
  assert.throws(() => compare('gte', '100.00', '1,234'), /Condition for "amount".*exact decimal/)
  assert.throws(() => compare('gte', '100.00', ''), /Condition for "amount".*enter a comparison value/)
})

test('established empty form and boolean comparison semantics remain stable', () => {
  for (const value of [null, undefined, '']) assert.equal(compare('lte', value, '0'), true)
  assert.equal(compare('gt', true, false as unknown as number), true)
  assert.equal(compare('eq', 'HEALTH', 'HEALTH'), true)
  assert.equal(compare('eq', '01', '1'), false)
})

test('typed numeric conditions preserve exact string equality and membership without coercing text identifiers', () => {
  const ctx = { values: { amount: '100.0000', accountCode: '01', maximum: '999999999999900.02' }, rows: {} }
  for (const op of ['eq', 'in'] as const) {
    const rule = logicRuleSchema.parse({ op, field: 'amount', value: op === 'in' ? ['100'] : '100', valueType: 'number' })
    assert.equal(evaluateLogicRule(rule, ctx), true)
  }
  assert.equal(evaluateLogicRule({ op: 'eq', field: 'accountCode', value: '1' }, ctx), false)
  assert.equal(evaluateLogicRule({ op: 'eq', field: 'maximum', value: '999999999999900.01', valueType: 'number' }, ctx), false)
  assert.equal(evaluateLogicRule({ op: 'notIn', field: 'maximum', value: ['999999999999900.01'], valueType: 'number' }, ctx), true)
})
