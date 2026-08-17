import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { fiscalContextFor, resolvePreset } from './period-presets'

// An April-start fiscal year is the configuration that exposed calendar-year
// assumptions, so it anchors these tests; January start must stay exactly the
// calendar year.

describe('fiscalContextFor', () => {
  it('resolves an April-start fiscal year mid-year', () => {
    const ctx = fiscalContextFor('2026-08-16', 4)
    assert.equal(ctx.fiscalYear, 2027)
    assert.deepEqual(ctx.year, { from: '2026-04-01', to: '2027-03-31', label: 'FY 2027' })
    assert.deepEqual(ctx.yearToDate, { from: '2026-04-01', to: '2026-08-16', label: 'FY 2027 to date' })
    assert.equal(ctx.quarter, 2)
    assert.deepEqual(ctx.quarterRange, { from: '2026-07-01', to: '2026-09-30', label: 'Q2 FY 2027' })
    assert.deepEqual(ctx.priorYear, { from: '2025-04-01', to: '2026-03-31', label: 'FY 2026' })
    assert.deepEqual(ctx.priorYearToDate, { from: '2025-04-01', to: '2025-08-16', label: 'FY 2026 to date' })
  })

  it('degenerates to the calendar year for a January start', () => {
    const ctx = fiscalContextFor('2026-08-16', 1)
    assert.equal(ctx.fiscalYear, 2026)
    assert.deepEqual(ctx.year, { from: '2026-01-01', to: '2026-12-31', label: 'FY 2026' })
    assert.deepEqual(ctx.yearToDate, { from: '2026-01-01', to: '2026-08-16', label: 'FY 2026 to date' })
    assert.equal(ctx.quarter, 3)
  })

  it('handles the first day of the fiscal year', () => {
    const ctx = fiscalContextFor('2026-04-01', 4)
    assert.equal(ctx.fiscalYear, 2027)
    assert.deepEqual(ctx.yearToDate, { from: '2026-04-01', to: '2026-04-01', label: 'FY 2027 to date' })
    assert.equal(ctx.quarter, 1)
    assert.deepEqual(ctx.priorYearToDate, { from: '2025-04-01', to: '2025-04-01', label: 'FY 2026 to date' })
  })

  it('handles the last day of the fiscal year', () => {
    const ctx = fiscalContextFor('2027-03-31', 4)
    assert.equal(ctx.fiscalYear, 2027)
    assert.deepEqual(ctx.yearToDate, { from: '2026-04-01', to: '2027-03-31', label: 'FY 2027 to date' })
    assert.equal(ctx.quarter, 4)
  })

  it('clamps the PYTD comparative across month-length differences', () => {
    // Mar 29 2028 minus 12 months lands cleanly; Feb-29-style clamping is
    // exercised through addMonthsIso — a leap day maps to Feb 28 prior year.
    const ctx = fiscalContextFor('2028-02-29', 4)
    assert.equal(ctx.priorYearToDate.to, '2027-02-28')
  })

  it('agrees with the filter-bar presets it is built from', () => {
    const input = { startMonth: 4, today: '2026-08-16' }
    const ctx = fiscalContextFor(input.today, input.startMonth)
    assert.deepEqual(ctx.year, resolvePreset('this_fiscal_year', input))
    assert.deepEqual(ctx.yearToDate, resolvePreset('this_fiscal_year_to_date', input))
    assert.deepEqual(ctx.quarterRange, resolvePreset('this_fiscal_quarter', input))
    assert.deepEqual(ctx.priorYear, resolvePreset('last_fiscal_year', input))
  })
})
