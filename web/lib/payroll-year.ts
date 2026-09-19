import { suppliedValue } from './payroll-decimal-refusal'

/**
 * The sanity window for an operator-supplied payroll tax year, shared by the
 * year-end routes.
 *
 * This is a SANITY bound, not a statement of supported years: which years a
 * filing can actually be produced for is declared per country by the payroll
 * packs via `payrollTaxYearCoverage()` in `engine/src/payroll/packs.ts`
 * (supported and draft years plus editions). The generic layer cannot rewire
 * these parses to pack coverage because several sites parse the year before
 * they know — or ever learn — the country, and gating a field's validity on
 * a country resolved wrongly stops the field validating at all.
 */
export const PAYROLL_TAX_YEAR_SANITY_WINDOW = { min: 2020, max: 2100 } as const

/**
 * Why an operator-supplied year value was refused, read off the value
 * itself. Five situations, five remedies — the collapsed `invalid year`
 * this replaces could not say which one fired.
 *
 * A missing query parameter arrives as null, and `Number(null)` is 0: an
 * integer, so the old single guard refused it as out of range and the
 * operator read a range error for a value they never sent. Absent is its
 * own cause here. `Number(undefined)` (a missing body field) is NaN and
 * was always not-a-number; an empty string is absent, not zero.
 */
export type PayrollYearNullCause =
  | { cause: 'absent' }
  | { cause: 'not-a-number' }
  | { cause: 'non-integer' }
  | { cause: 'below-range'; year: number }
  | { cause: 'above-range'; year: number }

export function payrollYearNullCause(raw: unknown): PayrollYearNullCause | null {
  if (raw === null || raw === undefined) return { cause: 'absent' }
  if (typeof raw === 'string' && raw.trim() === '') return { cause: 'absent' }
  const year = Number(raw)
  if (Number.isNaN(year)) return { cause: 'not-a-number' }
  if (!Number.isInteger(year)) return { cause: 'non-integer' }
  if (year < PAYROLL_TAX_YEAR_SANITY_WINDOW.min) return { cause: 'below-range', year }
  if (year > PAYROLL_TAX_YEAR_SANITY_WINDOW.max) return { cause: 'above-range', year }
  return null
}

/**
 * The refusal for an operator-supplied year the window would not read.
 * Names the value received and the accepted range — the same discipline
 * the decimal refusals follow. Null when the year is accepted; the
 * accept/refuse sets are unchanged from the guard this replaces.
 */
export function payrollYearRefusal(raw: unknown): string | null {
  const cause = payrollYearNullCause(raw)
  if (cause === null) return null
  const { min, max } = PAYROLL_TAX_YEAR_SANITY_WINDOW
  switch (cause.cause) {
    case 'absent':
      return `year is required — pass a year between ${min} and ${max}`
    case 'not-a-number':
      return `year must be a whole number — "${suppliedValue(raw)}" is not a number; pass a year between ${min} and ${max}`
    case 'non-integer':
      return `year must be a whole year — got "${suppliedValue(raw)}"; pass a year between ${min} and ${max}`
    case 'below-range':
      return `year ${cause.year} is before ${min} — pass a year between ${min} and ${max}`
    case 'above-range':
      return `year ${cause.year} is after ${max} — pass a year between ${min} and ${max}`
  }
}
