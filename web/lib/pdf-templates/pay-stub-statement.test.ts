import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPayStubStatement, type StatementLine } from './pay-stub-statement'

const line = (over: Partial<StatementLine>): StatementLine => ({
  componentId: null, kind: 'earning', paymentKind: 'cash', description: '', systemKey: null,
  taxable: true, amount: '0', hours: null, rate: null, ...over,
})
const WITHHOLDING = new Set(['federal_tax', 'provincial_tax'])
/** Engine money helpers keep four places; compare at the cent. */
const c = (value: string | null) => (value == null ? null : Number(value).toFixed(2))

test('lines are grouped into the printed sections and carry year-to-date', () => {
  const statement = buildPayStubStatement(
    [
      line({ componentId: 'reg', description: 'Regular Wages', amount: '720.00', hours: '24', rate: '30.00' }),
      line({ componentId: 'reg', description: 'Regular Wages', amount: '480.00', hours: '16', rate: '30.00' }),
      line({ componentId: 'life', description: 'Group life', paymentKind: 'non_cash', amount: '5.00' }),
      line({ componentId: 'health', description: 'Health premium', paymentKind: 'non_cash', taxable: false, amount: '90.00' }),
      line({ componentId: 'fit', kind: 'deduction', systemKey: 'federal_tax', description: 'Federal Income Tax', amount: '110.00' }),
      line({ componentId: 'cpp', kind: 'deduction', systemKey: 'cpp', description: 'CPP', amount: '67.39' }),
      line({ componentId: 'er', kind: 'employer_contribution', description: 'CPP (employer)', amount: '67.39' }),
    ],
    [
      line({ componentId: 'reg', description: 'Regular Wages', amount: '15600.00', hours: '520' }),
      line({ componentId: 'stat', description: 'Statutory Holiday', amount: '720.00', hours: '24' }),
      line({ componentId: 'fit', kind: 'deduction', systemKey: 'federal_tax', description: 'Federal Income Tax', amount: '1430.00' }),
    ],
    WITHHOLDING,
  )
  assert.deepEqual(statement.earnings.map((r) => [r.description, c(r.current), c(r.ytd), c(r.hours), c(r.rate)]), [
    ['Regular Wages', '1200.00', '16800.00', '40.00', '30.00'],
    ['Statutory Holiday', '0.00', '720.00', '0.00', null],
  ])
  assert.deepEqual(statement.taxableCompanyItems.map((r) => r.description), ['Group life'],
    'a non-taxable non-cash premium is employer cost, not part of the statement')
  assert.deepEqual(statement.withholdings.map((r) => [r.description, c(r.current), c(r.ytd)]), [['Federal Income Tax', '110.00', '1540.00']])
  assert.deepEqual(statement.netAdjustments.map((r) => r.description), ['CPP'])
})

test('a component paid at two rates prints no single rate', () => {
  const statement = buildPayStubStatement([
    line({ componentId: 'reg', description: 'Regular Wages', amount: '300.00', hours: '10', rate: '30.00' }),
    line({ componentId: 'reg', description: 'Regular Wages', amount: '320.00', hours: '10', rate: '32.00' }),
  ], [], WITHHOLDING)
  assert.equal(statement.earnings[0]!.rate, null)
  assert.equal(c(statement.earnings[0]!.current), '620.00')
})
