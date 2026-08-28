import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { add, cmp, sum } from '../../../engine/src/money.ts'

const source = readFileSync(join(import.meta.dirname, 'cashflow-data.ts'), 'utf8')
const timelineSource = readFileSync(join(import.meta.dirname, '..', 'cash', 'cash-position.ts'), 'utf8')

test('cashflow resolver keeps forecast aggregates as canonical exact money', () => {
  assert.match(source, /startingCash: string/)
  assert.match(source, /totalInflows: string/)
  assert.match(source, /runwayWeeks: string \| null/)
  assert.match(source, /sumMoney\(/)
  assert.match(source, /divideMoney\(/)
  assert.doesNotMatch(source, /Number\([^\n]*(?:amount|balance|remaining|inflow|outflow|cash|total)/)
})

test('cashflow timeline sums fractional, negative, and beyond-safe values exactly', () => {
  const huge = '9007199254740993.0000'
  assert.match(timelineSource, /startingCash: string/)
  assert.match(timelineSource, /running = addMoney\(running, net\)/)
  assert.match(timelineSource, /totalIn = addMoney\(totalIn, inflow\)/)
  assert.match(timelineSource, /totalOut = addMoney\(totalOut, outflow\)/)
  assert.doesNotMatch(timelineSource, /running\s*\+=|totalIn\s*\+=|totalOut\s*\+=/)

  // Representative ledger values that used to round differently when passed
  // through Number: one fractional credit, one negative opening balance, and
  // a valid numeric(19,4) value beyond Number.MAX_SAFE_INTEGER.
  assert.equal(add(huge, '-0.1251'), '9007199254740992.8749')
  assert.equal(add('-0.1250', '9007199254740992.8749'), '9007199254740992.7499')
  assert.equal(add('-0.1250', '0.0001'), '-0.1249')
  assert.equal(sum([huge, '-0.1250', '0.0001']), '9007199254740992.8751')
  assert.equal(cmp(huge, '9007199254740992.9999'), 1)
})
