import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateGroup,
  lineMatchesRule,
  resolveSplitAmounts,
  ruleAppliesToAccount,
  type BankLine,
  type RuleConditionGroup,
  type RuleSplitLine,
} from './banking-rules-core.ts'

const line = (over: Partial<BankLine> = {}): BankLine => ({
  id: 'l1',
  posted_on: '2026-07-10',
  amount: '1204.55',
  description: 'STRIPE TRANSFER ST-A4F2',
  counterparty_ref: 'stripe.com',
  currency: 'USD',
  source: 'ofx',
  ...over,
})

const FIXED_NOW = Date.parse('2026-07-20T00:00:00Z')

test('text operators match description and payee', () => {
  const g: RuleConditionGroup = {
    combinator: 'and',
    rules: [
      { field: 'description', op: 'startsWith', value: 'STRIPE' },
      { field: 'payee', op: 'contains', value: 'stripe.com' },
    ],
  }
  assert.equal(evaluateGroup(line(), g, FIXED_NOW), true)
  assert.equal(evaluateGroup(line({ description: 'ACH DEBIT' }), g, FIXED_NOW), false)
})

test('anyText spans description and counterparty', () => {
  const g: RuleConditionGroup = { combinator: 'and', rules: [{ field: 'anyText', op: 'contains', value: 'stripe.com' }] }
  assert.equal(evaluateGroup(line({ description: 'PAYOUT' }), g, FIXED_NOW), true)
})

test('and vs or grouping', () => {
  const g: RuleConditionGroup = {
    combinator: 'or',
    rules: [
      { field: 'description', op: 'contains', value: 'nope' },
      { field: 'flow', op: 'is', value: 'in' },
    ],
  }
  assert.equal(evaluateGroup(line(), g, FIXED_NOW), true) // money-in wins the OR
  const gAnd: RuleConditionGroup = { ...g, combinator: 'and' }
  assert.equal(evaluateGroup(line(), gAnd, FIXED_NOW), false)
})

test('nested groups: (A and B) or C', () => {
  const g: RuleConditionGroup = {
    combinator: 'or',
    rules: [
      {
        combinator: 'and',
        rules: [
          { field: 'flow', op: 'is', value: 'out' },
          { field: 'amount', op: 'gt', value: 500 },
        ],
      },
      { field: 'description', op: 'contains', value: 'stripe' },
    ],
  }
  assert.equal(evaluateGroup(line(), g, FIXED_NOW), true) // matches "stripe" branch
  assert.equal(evaluateGroup(line({ description: 'WIRE', amount: '-800' }), g, FIXED_NOW), true) // matches out+>500
  assert.equal(evaluateGroup(line({ description: 'WIRE', amount: '-100' }), g, FIXED_NOW), false)
})

test('amount uses absolute value; between and comparisons', () => {
  const g = (op: string, value: any): RuleConditionGroup => ({ combinator: 'and', rules: [{ field: 'amount', op: op as any, value }] })
  assert.equal(evaluateGroup(line({ amount: '-250' }), g('between', [100, 300]), FIXED_NOW), true)
  assert.equal(evaluateGroup(line({ amount: '-250' }), g('gt', 300), FIXED_NOW), false)
  assert.equal(evaluateGroup(line({ amount: '-250' }), g('lte', 250), FIXED_NOW), true)
})

test('date withinDays honours the injected clock', () => {
  const g: RuleConditionGroup = { combinator: 'and', rules: [{ field: 'date', op: 'withinDays', value: 15 }] }
  assert.equal(evaluateGroup(line({ posted_on: '2026-07-10' }), g, FIXED_NOW), true) // 10 days ago
  assert.equal(evaluateGroup(line({ posted_on: '2026-06-01' }), g, FIXED_NOW), false) // 49 days ago
})

test('lineMatchesRule evaluates the condition tree', () => {
  assert.equal(lineMatchesRule(line(), { version: 2, match: { combinator: 'and', rules: [{ field: 'flow', op: 'is', value: 'in' }] } }, FIXED_NOW), true)
})

test('accountScope gates rules', () => {
  assert.equal(ruleAppliesToAccount({ version: 2, match: { combinator: 'and', rules: [] }, accountScope: ['acc-1'] }, 'acc-1'), true)
  assert.equal(ruleAppliesToAccount({ version: 2, match: { combinator: 'and', rules: [] }, accountScope: ['acc-1'] }, 'acc-2'), false)
  assert.equal(ruleAppliesToAccount({ version: 2, match: { combinator: 'and', rules: [] } }, 'acc-2'), true) // no scope = all
})

test('split: single remainder line equals the negated bank amount', () => {
  const lines: RuleSplitLine[] = [{ accountId: 'a', portion: { kind: 'remainder' } }]
  const r = resolveSplitAmounts('1204.55', lines)
  // Splits resolve at the ledger's numeric(19,4) scale, so amounts are 4dp.
  assert.equal(r[0]!.amount, '-1204.5500')
})

test('split: percent + remainder balances exactly at ledger scale (deposit)', () => {
  const lines: RuleSplitLine[] = [
    { accountId: 'revenue', portion: { kind: 'remainder' } },
    { accountId: 'fees', portion: { kind: 'percent', value: 2.9 } },
  ]
  const r = resolveSplitAmounts('1204.55', lines)
  const fee = r.find((x) => x.line.accountId === 'fees')!.amount
  const rev = r.find((x) => x.line.accountId === 'revenue')!.amount
  // 1204.55 × 2.9% = 34.93195 → 34.9320 at the 4dp ledger scale (was clamped
  // to 2dp); the remainder line absorbs the rest exactly, no stranded delta.
  assert.equal(fee, '-34.9320')
  assert.equal(rev, '-1169.6180')
  const sum = r.reduce((a, x) => a + Number(x.amount), 0)
  assert.equal(Math.round(sum * 100) / 100, -1204.55) // offsets negate the bank line exactly
})

test('split: fixed + remainder on a withdrawal keeps offsets positive', () => {
  const lines: RuleSplitLine[] = [
    { accountId: 'principal', portion: { kind: 'remainder' } },
    { accountId: 'wireFee', portion: { kind: 'fixed', value: 15 } },
  ]
  const r = resolveSplitAmounts('-500', lines) // money out: bank credited (negative)
  const total = r.reduce((a, x) => a + Number(x.amount), 0)
  assert.equal(Math.round(total * 100) / 100, 500) // offsets are positive debits summing to +500
  assert.equal(r.find((x) => x.line.accountId === 'wireFee')!.amount, '15.0000')
  assert.equal(r.find((x) => x.line.accountId === 'principal')!.amount, '485.0000')
})

test('split: no remainder folds rounding into the last line', () => {
  const lines: RuleSplitLine[] = [
    { accountId: 'a', portion: { kind: 'percent', value: 33.333 } },
    { accountId: 'b', portion: { kind: 'percent', value: 66.667 } },
  ]
  const r = resolveSplitAmounts('100', lines)
  // Exact at 4dp — the fold branch leaves both lines untouched here.
  assert.equal(r[0]!.amount, '-33.3330')
  assert.equal(r[1]!.amount, '-66.6670')
  const sum = r.reduce((a, x) => a + Number(x.amount), 0)
  assert.equal(Math.round(sum * 100) / 100, -100) // still balances despite rounding
})
