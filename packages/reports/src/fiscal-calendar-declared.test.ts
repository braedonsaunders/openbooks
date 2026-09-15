import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  declaredPeriodColumns,
  declaredPeriodContaining,
  declaredPeriodQuarter,
  declaredPeriodsCover,
  declaredQuarterColumns,
  declaredQuarterContaining,
  declaredFiscalYearRange,
  type FiscalPeriod,
} from './fiscal-calendar'

// A 4-4-5 FY2026 fragment: P1 (4w) 2026-02-02..2026-03-01, P2 (4w)
// 2026-03-02..2026-03-29, P3 (5w) 2026-03-30..2026-05-03, P4 (4w)
// 2026-05-04..2026-05-31 — week-based bounds that never align to month ends.
const P445: FiscalPeriod[] = [
  { fiscalYear: 2026, periodNumber: 1, name: 'P01 FY2026', from: '2026-02-02', to: '2026-03-01' },
  { fiscalYear: 2026, periodNumber: 2, name: 'P02 FY2026', from: '2026-03-02', to: '2026-03-29' },
  { fiscalYear: 2026, periodNumber: 3, name: 'P03 FY2026', from: '2026-03-30', to: '2026-05-03' },
  { fiscalYear: 2026, periodNumber: 4, name: 'P04 FY2026', from: '2026-05-04', to: '2026-05-31' },
  { fiscalYear: 2026, periodNumber: 5, name: 'P05 FY2026', from: '2026-06-01', to: '2026-06-28' },
  { fiscalYear: 2026, periodNumber: 6, name: 'P06 FY2026', from: '2026-06-29', to: '2026-08-02' },
]

describe('declaredPeriodQuarter', () => {
  it('groups three periods per quarter', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(declaredPeriodQuarter), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])
  })

  it('folds a thirteen-period remainder into Q4, never a phantom Q5', () => {
    assert.equal(declaredPeriodQuarter(13), 4)
    assert.equal(declaredPeriodQuarter(14), 4)
  })
})

describe('declaredPeriodColumns', () => {
  it('emits one column per overlapping fiscal period with the period name', () => {
    assert.deepEqual(declaredPeriodColumns(P445, '2026-03-01', '2026-05-04'), [
      { from: '2026-02-02', to: '2026-03-01', label: 'P01 FY2026' },
      { from: '2026-03-02', to: '2026-03-29', label: 'P02 FY2026' },
      { from: '2026-03-30', to: '2026-05-03', label: 'P03 FY2026' },
      { from: '2026-05-04', to: '2026-05-31', label: 'P04 FY2026' },
    ])
  })

  it('keeps a 5-week period whole instead of splitting it across calendar months', () => {
    // April 2026 sits entirely inside the 5-week P03; calendar math would
    // split the month's activity across two "2026-04"-style columns.
    const cols = declaredPeriodColumns(P445, '2026-04-01', '2026-04-30')
    assert.equal(cols.length, 1)
    assert.deepEqual(cols[0], { from: '2026-03-30', to: '2026-05-03', label: 'P03 FY2026' })
  })

  it('returns no columns when nothing overlaps', () => {
    assert.deepEqual(declaredPeriodColumns(P445, '2025-01-01', '2025-01-31'), [])
  })
})

describe('declaredQuarterColumns', () => {
  it('groups declared periods three-per-quarter with fiscal quarter labels', () => {
    assert.deepEqual(declaredQuarterColumns(P445, '2026-02-02', '2026-08-02'), [
      { from: '2026-02-02', to: '2026-05-03', label: 'Q1 FY 2026' },
      { from: '2026-05-04', to: '2026-08-02', label: 'Q2 FY 2026' },
    ])
  })

  it('uses full group bounds for a mid-quarter window', () => {
    assert.deepEqual(declaredQuarterColumns(P445, '2026-04-01', '2026-04-30'), [
      { from: '2026-02-02', to: '2026-05-03', label: 'Q1 FY 2026' },
    ])
  })
})

describe('declaredPeriodsCover', () => {
  it('holds when declared periods span the window without gaps', () => {
    assert.equal(declaredPeriodsCover(P445, '2026-02-02', '2026-08-02'), true)
    assert.equal(declaredPeriodsCover(P445, '2026-03-15', '2026-04-15'), true)
  })

  it('fails when the window starts before, ends after, or straddles a gap', () => {
    assert.equal(declaredPeriodsCover(P445, '2026-02-01', '2026-08-02'), false)
    assert.equal(declaredPeriodsCover(P445, '2026-02-02', '2026-08-03'), false)
    const gapped = P445.filter((p) => p.periodNumber !== 2)
    assert.equal(declaredPeriodsCover(gapped, '2026-02-02', '2026-08-02'), false)
    assert.equal(declaredPeriodsCover([], '2026-02-02', '2026-08-02'), false)
  })
})

describe('declared lookups', () => {
  it('finds the period holding a date', () => {
    assert.equal(declaredPeriodContaining(P445, '2026-04-15')?.name, 'P03 FY2026')
    assert.equal(declaredPeriodContaining(P445, '2025-01-01'), null)
  })

  it('finds the quarter holding a date', () => {
    assert.deepEqual(declaredQuarterContaining(P445, '2026-04-15'), {
      from: '2026-02-02',
      to: '2026-05-03',
      label: 'Q1 FY 2026',
    })
    assert.equal(declaredQuarterContaining(P445, '2025-01-01'), null)
  })

  it('resolves the whole declared fiscal year holding a date', () => {
    assert.deepEqual(declaredFiscalYearRange(P445, '2026-04-15'), {
      from: '2026-02-02',
      to: '2026-08-02',
      label: 'FY 2026',
      fiscalYear: 2026,
    })
    assert.equal(declaredFiscalYearRange(P445, '2025-01-01'), null)
  })
})
