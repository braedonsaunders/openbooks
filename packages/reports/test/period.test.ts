// Run with:  node --import tsx --test packages/reports/test/period.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fiscalYearRangeFor,
  fiscalQuarterRange,
  fiscalMonthsBetween,
  fiscalQuartersBetween,
} from '../src/fiscal-calendar.ts'
import { PERIOD_PRESETS, resolvePreset } from '../src/period-presets.ts'

const APRIL = 4 // reference organization's fiscal start month
const JAN = 1
const TODAY = '2026-07-15'

test('fiscal year boundaries — April start', () => {
  // 2026-07-15 is in FY2027 (Apr 2026 → Mar 2027) for an April start.
  assert.deepEqual(fiscalYearRangeFor(2027, APRIL), {
    from: '2026-04-01',
    to: '2027-03-31',
    label: 'FY 2027',
  })
})

test('fiscal year boundaries — January start equals calendar year', () => {
  assert.deepEqual(fiscalYearRangeFor(2026, JAN), {
    from: '2026-01-01',
    to: '2026-12-31',
    label: 'FY 2026',
  })
})

test('fiscal quarter boundaries — April start', () => {
  // Q1 = Apr–Jun, Q2 = Jul–Sep of FY2027.
  assert.equal(fiscalQuarterRange(2027, 1, APRIL).from, '2026-04-01')
  assert.equal(fiscalQuarterRange(2027, 1, APRIL).to, '2026-06-30')
  assert.equal(fiscalQuarterRange(2027, 2, APRIL).from, '2026-07-01')
  assert.equal(fiscalQuarterRange(2027, 2, APRIL).to, '2026-09-30')
})

test('resolvePreset — April start, key presets', () => {
  const r = (id: string) => resolvePreset(id, { startMonth: APRIL, today: TODAY })!
  assert.deepEqual({ from: r('this_fiscal_year').from, to: r('this_fiscal_year').to }, {
    from: '2026-04-01',
    to: '2027-03-31',
  })
  assert.deepEqual({ from: r('last_fiscal_year').from, to: r('last_fiscal_year').to }, {
    from: '2025-04-01',
    to: '2026-03-31',
  })
  assert.deepEqual({ from: r('this_fiscal_quarter').from, to: r('this_fiscal_quarter').to }, {
    from: '2026-07-01',
    to: '2026-09-30',
  })
  assert.deepEqual({ from: r('this_month').from, to: r('this_month').to }, {
    from: '2026-07-01',
    to: '2026-07-31',
  })
  assert.deepEqual({ from: r('last_month').from, to: r('last_month').to }, {
    from: '2026-06-01',
    to: '2026-06-30',
  })
  assert.equal(r('this_fiscal_year_to_date').from, '2026-04-01')
  assert.equal(r('this_fiscal_year_to_date').to, TODAY)
  assert.equal(r('last_7_days').from, '2026-07-09')
  assert.equal(r('last_7_days').to, TODAY)
  assert.equal(r('same_fiscal_quarter_last_year').from, '2025-07-01')
})

test('resolvePreset — January start', () => {
  const r = resolvePreset('this_fiscal_year', { startMonth: JAN, today: TODAY })!
  assert.deepEqual({ from: r.from, to: r.to, label: r.label }, {
    from: '2026-01-01',
    to: '2026-12-31',
    label: 'FY 2026',
  })
})

test('every non-custom preset resolves for both start months', () => {
  for (const preset of PERIOD_PRESETS) {
    if (preset.id === 'custom') {
      assert.equal(resolvePreset('custom', { startMonth: APRIL, today: TODAY }), null)
      continue
    }
    for (const sm of [JAN, APRIL]) {
      const r = resolvePreset(preset.id, { startMonth: sm, today: TODAY })
      assert.ok(r, `preset ${preset.id} (start ${sm}) resolved`)
      assert.ok(r!.from <= r!.to, `preset ${preset.id}: from<=to (${r!.from}..${r!.to})`)
    }
  }
})

test('custom preset uses supplied bounds', () => {
  const r = resolvePreset('custom', {
    startMonth: APRIL,
    today: TODAY,
    customFrom: '2026-01-01',
    customTo: '2026-06-30',
  })
  assert.deepEqual({ from: r!.from, to: r!.to }, { from: '2026-01-01', to: '2026-06-30' })
})

test('month/quarter enumeration for breakout columns', () => {
  assert.equal(fiscalMonthsBetween('2026-04-01', '2026-06-30').length, 3)
  assert.equal(fiscalMonthsBetween('2026-04-15', '2026-04-20').length, 1)
  const q = fiscalQuartersBetween('2026-04-01', '2027-03-31', APRIL)
  assert.equal(q.length, 4)
  assert.equal(q[0]!.from, '2026-04-01')
  assert.equal(q[3]!.to, '2027-03-31')
})
