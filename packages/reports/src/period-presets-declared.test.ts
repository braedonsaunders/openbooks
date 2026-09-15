import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { resolvePreset } from './period-presets'
import type { FiscalPeriod } from './fiscal-calendar'

// 4-4-5 FY2026 (P1–P6) plus the tail of FY2025 so prior-period presets resolve.
const P445: FiscalPeriod[] = [
  { fiscalYear: 2025, periodNumber: 10, name: 'P10 FY2025', from: '2025-11-03', to: '2025-11-30' },
  { fiscalYear: 2025, periodNumber: 11, name: 'P11 FY2025', from: '2025-12-01', to: '2025-12-28' },
  { fiscalYear: 2025, periodNumber: 12, name: 'P12 FY2025', from: '2025-12-29', to: '2026-02-01' },
  { fiscalYear: 2026, periodNumber: 1, name: 'P01 FY2026', from: '2026-02-02', to: '2026-03-01' },
  { fiscalYear: 2026, periodNumber: 2, name: 'P02 FY2026', from: '2026-03-02', to: '2026-03-29' },
  { fiscalYear: 2026, periodNumber: 3, name: 'P03 FY2026', from: '2026-03-30', to: '2026-05-03' },
  { fiscalYear: 2026, periodNumber: 4, name: 'P04 FY2026', from: '2026-05-04', to: '2026-05-31' },
  { fiscalYear: 2026, periodNumber: 5, name: 'P05 FY2026', from: '2026-06-01', to: '2026-06-28' },
  { fiscalYear: 2026, periodNumber: 6, name: 'P06 FY2026', from: '2026-06-29', to: '2026-08-02' },
]

const TODAY = '2026-04-15' // inside the 5-week P03 FY2026

describe('resolvePreset with declared fiscal periods', () => {
  it('resolves period/month presets to the holding fiscal period', () => {
    const input = { startMonth: 2, today: TODAY, periods: P445 }
    assert.deepEqual(resolvePreset('this_period', input), { from: '2026-03-30', to: '2026-05-03', label: 'P03 FY2026' })
    assert.deepEqual(resolvePreset('this_month', input), { from: '2026-03-30', to: '2026-05-03', label: 'P03 FY2026' })
    assert.deepEqual(resolvePreset('last_period', input), { from: '2026-03-02', to: '2026-03-29', label: 'P02 FY2026' })
    assert.deepEqual(resolvePreset('period_before_last', input), { from: '2026-02-02', to: '2026-03-01', label: 'P01 FY2026' })
    assert.deepEqual(resolvePreset('this_period_to_date', input), { from: '2026-03-30', to: TODAY, label: 'P03 FY2026 to date' })
  })

  it('resolves quarter presets by grouping declared periods', () => {
    const input = { startMonth: 2, today: TODAY, periods: P445 }
    assert.deepEqual(resolvePreset('this_fiscal_quarter', input), { from: '2026-02-02', to: '2026-05-03', label: 'Q1 FY 2026' })
    assert.deepEqual(resolvePreset('this_fiscal_quarter_to_date', input), { from: '2026-02-02', to: TODAY, label: 'Q1 FY 2026 to date' })
    assert.deepEqual(resolvePreset('last_fiscal_quarter', input), { from: '2025-11-03', to: '2026-02-01', label: 'Q4 FY 2025' })
  })

  it('resolves fiscal-year presets to the declared year bounds', () => {
    const input = { startMonth: 2, today: TODAY, periods: P445 }
    assert.deepEqual(resolvePreset('this_fiscal_year', input), { from: '2026-02-02', to: '2026-08-02', label: 'FY 2026' })
    assert.deepEqual(resolvePreset('this_fiscal_year_to_date', input), { from: '2026-02-02', to: TODAY, label: 'FY 2026 to date' })
    assert.deepEqual(resolvePreset('last_fiscal_year', input), { from: '2025-11-03', to: '2026-02-01', label: 'FY 2025' })
  })

  it('falls back to calendar math when the date sits outside generated periods', () => {
    const input = { startMonth: 2, today: '2027-06-01', periods: P445 }
    // No declared period holds 2027-06-01: the old calendar answer stands.
    assert.deepEqual(resolvePreset('this_month', input), { from: '2027-06-01', to: '2027-06-30', label: '2027-06' })
    assert.deepEqual(resolvePreset('this_fiscal_quarter', input), { from: '2027-05-01', to: '2027-07-31', label: 'Q2 FY 2028' })
  })

  it('leaves non-period presets untouched when periods are supplied', () => {
    const input = { startMonth: 2, today: TODAY, periods: P445 }
    assert.deepEqual(resolvePreset('trailing_3_months', input), {
      from: '2026-01-16',
      to: TODAY,
      label: 'Trailing 3 months',
    })
    assert.deepEqual(resolvePreset('today', input), { from: TODAY, to: TODAY, label: TODAY })
  })

  it('stays byte-identical without periods', () => {
    const input = { startMonth: 2, today: TODAY }
    assert.deepEqual(resolvePreset('this_month', input), { from: '2026-04-01', to: '2026-04-30', label: '2026-04' })
    assert.deepEqual(resolvePreset('this_fiscal_quarter', input), { from: '2026-02-01', to: '2026-04-30', label: 'Q1 FY 2027' })
  })
})
