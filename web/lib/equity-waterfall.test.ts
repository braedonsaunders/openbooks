import assert from 'node:assert/strict'
import test from 'node:test'
import type { WaterfallResult } from '@openbooks/engine/equity'
import { sum } from '@openbooks/engine/money/money'
import { conversionDecisions, curveSeries, defaultExitAnchor, exitPresets, payoutLines, percentOf, waterfallSteps } from './equity-waterfall'

const SA = 'c0000000-0000-4000-8000-0000000000a1'
const SEED = 'c0000000-0000-4000-8000-0000000000a2'
const CS = 'c0000000-0000-4000-8000-0000000000a3'
const HOLDER = 'b0000000-0000-4000-8000-0000000000b1'

type ClassRow = WaterfallResult['classes'][number]
const preferred = (shareClassId: string, code: string, seniority: number, values: Partial<ClassRow>): ClassRow => ({
  shareClassId, code, kind: 'preferred', seniority, participationMode: 'none', converted: false, preference: '0.0000', participation: '0.0000',
  total: '0.0000', perShare: '0.0000000000', preferenceEntitlement: '0.0000', participationCap: null, alternativeTotal: null, ...values,
})

/**
 * A 10,000,000 exit with 500,000 of fees: Series A (senior, 1x non-participating) keeps its
 * 3,000,000 preference, the Seed class converts, a capped SAFE converts, a note is repaid, and
 * common and the awards share the residual.
 */
const result: WaterfallResult = {
  exitValue: '9500000.0000',
  pricePerCommonShare: '1.0500000000',
  classes: [
    preferred(SA, 'SA', 2, { preference: '3000000.0000', total: '3000000.0000', perShare: '3.0000000000', preferenceEntitlement: '3000000.0000', alternativeTotal: '2400000.0000' }),
    preferred(SEED, 'SEED', 1, { converted: true, participation: '1500000.0000', total: '1500000.0000', perShare: '1.5000000000', preferenceEntitlement: '1000000.0000', alternativeTotal: '1000000.0000' }),
    { ...preferred(CS, 'CS', 0, { participation: '4200000.0000', total: '4200000.0000', perShare: '1.0500000000' }), kind: 'common' },
  ],
  payouts: [
    { securityId: 's1', holderPartyId: HOLDER, kind: 'share', shareClassId: SA, amount: '3000000.0000' },
    { securityId: 's2', holderPartyId: HOLDER, kind: 'share', shareClassId: SEED, amount: '1500000.0000' },
    { securityId: 's3', holderPartyId: HOLDER, kind: 'share', shareClassId: CS, amount: '4200000.0000' },
    { securityId: 'o1', holderPartyId: HOLDER, kind: 'award', shareClassId: CS, amount: '500000.0000' },
    { securityId: 'f1', holderPartyId: HOLDER, kind: 'safe', shareClassId: null, amount: '200000.0000' },
    { securityId: 'n1', holderPartyId: HOLDER, kind: 'note', shareClassId: null, amount: '100000.0000' },
  ],
  holders: [{ holderPartyId: HOLDER, amount: '9500000.0000', percent: '100.0000' }],
  safes: [{ securityId: 'f1', holderPartyId: HOLDER, converted: true, shares: '190476.1904761905', amount: '200000.0000', cashOutAmount: '150000.0000', alternativeAmount: '150000.0000' }],
  unallocated: '0.0000',
}

test('the waterfall opens on the latest priced round in the functional currency, with exact preset multiples', () => {
  const rounds = [
    { name: 'Series Seed', closedOn: '2024-06-28', currency: 'USD', preMoneyValuation: '9000000.0000', raised: '3600000.0000' },
    { name: 'Series A', closedOn: '2025-09-30', currency: 'USD', preMoneyValuation: '53200000.0000', raised: '14000000.0000' },
    { name: 'Bridge (EUR)', closedOn: '2026-01-15', currency: 'EUR', preMoneyValuation: '70000000.0000', raised: '2000000.0000' },
    { name: 'Series B', closedOn: '2026-11-01', currency: 'USD', preMoneyValuation: '150000000.0000', raised: '30000000.0000' },
  ]
  const anchor = defaultExitAnchor(rounds, '2026-10-18', 'USD')
  assert.deepEqual(anchor, { roundName: 'Series A', closedOn: '2025-09-30', postMoney: '67200000.0000' }, 'a later or foreign-currency round never anchors the default')
  assert.deepEqual(exitPresets(anchor!.postMoney), [
    { multiple: '0.5', value: '33600000.0000' },
    { multiple: '1', value: '67200000.0000' },
    { multiple: '2', value: '134400000.0000' },
    { multiple: '5', value: '336000000.0000' },
  ])
  assert.equal(defaultExitAnchor(rounds, '2024-01-01', 'USD'), null, 'no round yet: the page asks for an exit value')
  assert.deepEqual(exitPresets(null), [])
  assert.deepEqual(exitPresets('0.0000'), [])
})

test('the payment cascade runs fees, notes, preferences by seniority, then the residual, and sums to the exit value', () => {
  const steps = waterfallSteps(result, '500000.0000')
  assert.deepEqual(steps.map((step) => [step.kind, step.code, step.amount]), [
    ['fees', null, '500000.0000'],
    ['notes', null, '100000.0000'],
    ['preference', 'SA', '3000000.0000'],
    ['participation', 'SEED', '1500000.0000'],
    ['participation', 'CS', '4200000.0000'],
    ['safe_conversion', null, '200000.0000'],
    ['awards', null, '500000.0000'],
  ])
  assert.equal(sum(steps.map((step) => step.amount)), '10000000.0000', 'the cascade accounts for every unit of the gross exit')
})

test('payout lines by recipient sum to the proceeds and carry each class election', () => {
  const lines = payoutLines(result)
  assert.deepEqual(lines.map((line) => line.key), [`class:${SA}`, `class:${SEED}`, `class:${CS}`, 'awards', 'safes', 'notes'])
  assert.equal(sum(lines.map((line) => line.total)), result.exitValue)
  assert.deepEqual(lines.slice(0, 3).map((line) => line.converted), [false, true, null], 'common has no election')
  assert.equal(lines[0]!.percent, '31.58')
  assert.equal(percentOf('1', '3'), '33.33')
  assert.equal(percentOf('2', '3'), '66.67')
  assert.equal(percentOf('5', '0'), '0.00')
})

test('each elector shows its choice with the amount the other choice would pay', () => {
  assert.deepEqual(conversionDecisions(result).map((row) => [row.code ?? row.securityId, row.decision, row.amount, row.entitlement, row.alternative]), [
    ['SA', 'keeps_preference', '3000000.0000', '3000000.0000', '2400000.0000'],
    ['SEED', 'converts', '1500000.0000', '1000000.0000', '1000000.0000'],
    ['f1', 'safe_converts', '200000.0000', '150000.0000', '150000.0000'],
  ])
})

test('the proceeds curve has one series per recipient that is ever paid, senior preferred first', () => {
  const zero: WaterfallResult = { ...result, exitValue: '0.0000', classes: result.classes.map((row) => ({ ...row, total: '0.0000' })), payouts: result.payouts.map((row) => ({ ...row, amount: '0.0000' })) }
  const { exitValues, series } = curveSeries([{ exitValue: '0.0000', result: zero }, { exitValue: '10000000.0000', result }])
  assert.deepEqual(exitValues, ['0.0000', '10000000.0000'])
  assert.deepEqual(series.map((row) => [row.key, row.code, row.data]), [
    [`class:${SA}`, 'SA', ['0.0000', '3000000.0000']],
    [`class:${SEED}`, 'SEED', ['0.0000', '1500000.0000']],
    [`class:${CS}`, 'CS', ['0.0000', '4200000.0000']],
    ['awards', null, ['0.0000', '500000.0000']],
    ['safes', null, ['0.0000', '200000.0000']],
    ['notes', null, ['0.0000', '100000.0000']],
  ])
  assert.deepEqual(curveSeries([{ exitValue: '0.0000', result: zero }]).series, [], 'a recipient never paid draws no line')
})
