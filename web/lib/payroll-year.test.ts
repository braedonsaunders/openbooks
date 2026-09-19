import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PAYROLL_TAX_YEAR_SANITY_WINDOW,
  payrollYearNullCause,
  payrollYearRefusal,
} from './payroll-year'

test('an absent year is its own cause, not a range error over zero', () => {
  // A missing query parameter arrives as null and Number(null) is 0 — an
  // integer, so the old single guard refused it as out of range. The
  // operator read a range error for a value they never sent.
  assert.deepEqual(payrollYearNullCause(null), { cause: 'absent' })
  assert.deepEqual(payrollYearNullCause(undefined), { cause: 'absent' })
  assert.deepEqual(payrollYearNullCause(''), { cause: 'absent' })
  assert.deepEqual(payrollYearNullCause('   '), { cause: 'absent' })
  const refusal = payrollYearRefusal(null)
  assert.match(refusal ?? '', /year is required/)
  assert.match(refusal ?? '', /2020/)
  assert.match(refusal ?? '', /2100/)
})

test('a numeric zero is below the range, naming the zero', () => {
  // Zero is what Number(null) used to become. A real zero still refuses —
  // but as below-range, naming the value, not as absent.
  assert.deepEqual(payrollYearNullCause(0), { cause: 'below-range', year: 0 })
  assert.match(payrollYearRefusal(0) ?? '', /0/)
  assert.match(payrollYearRefusal(0) ?? '', /2020/)
})

test('a non-number is refused as not-a-number, naming the value', () => {
  assert.deepEqual(payrollYearNullCause('abc'), { cause: 'not-a-number' })
  assert.deepEqual(payrollYearNullCause(Number.NaN), { cause: 'not-a-number' })
  const refusal = payrollYearRefusal('abc') ?? ''
  assert.match(refusal, /not a number/)
  assert.match(refusal, /abc/)
  assert.match(refusal, /2020/)
  assert.match(refusal, /2100/)
})

test('a non-integer is refused as non-integer, naming the value', () => {
  assert.deepEqual(payrollYearNullCause(2026.5), { cause: 'non-integer' })
  assert.deepEqual(payrollYearNullCause('2026.5'), { cause: 'non-integer' })
  const refusal = payrollYearRefusal(2026.5) ?? ''
  assert.match(refusal, /whole year/)
  assert.match(refusal, /2026\.5/)
  assert.match(refusal, /2020/)
  assert.match(refusal, /2100/)
})

test('a year below the window names the year and the range', () => {
  assert.deepEqual(payrollYearNullCause(2019), { cause: 'below-range', year: 2019 })
  const refusal = payrollYearRefusal(2019) ?? ''
  assert.match(refusal, /2019/)
  assert.match(refusal, /2020/)
  assert.match(refusal, /2100/)
})

test('a year above the window names the year and the range', () => {
  assert.deepEqual(payrollYearNullCause(2101), { cause: 'above-range', year: 2101 })
  const refusal = payrollYearRefusal(2101) ?? ''
  assert.match(refusal, /2101/)
  assert.match(refusal, /2020/)
  assert.match(refusal, /2100/)
})

test('both boundary years are accepted, as numbers and as query strings', () => {
  const { min, max } = PAYROLL_TAX_YEAR_SANITY_WINDOW
  assert.equal(min, 2020)
  assert.equal(max, 2100)
  for (const accepted of [2020, 2100, '2020', '2100', 2026, '2026'] as const) {
    assert.equal(payrollYearNullCause(accepted), null)
    assert.equal(payrollYearRefusal(accepted), null)
  }
})

test('the accept/refuse sets match the guard this replaces', () => {
  const legacy = (raw: unknown): boolean => {
    const year = Number(raw)
    return Number.isInteger(year) && year >= 2020 && year <= 2100
  }
  const samples: unknown[] = [
    null, undefined, '', '   ', 'abc', '2026.5', 2026.5, Number.NaN,
    Number.POSITIVE_INFINITY, 0, 2019, '2019', 2101, '2101',
    2020, 2100, '2020', '2100', 2026, '2026', true, [2026], {},
  ]
  for (const sample of samples) {
    assert.equal(
      payrollYearRefusal(sample) === null,
      legacy(sample),
      `accept/refuse diverged for ${String(sample)}`,
    )
  }
})
