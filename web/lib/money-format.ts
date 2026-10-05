/**
 * Locale-aware monetary presentation.
 *
 * Currency is always an ISO 4217 code supplied by the owning document,
 * subsidiary, or organization. Locale only controls presentation; it must
 * never be used to guess the currency.
 */

import { minorToMajor } from './setup/money-fields.ts'

export type MoneyValue = string | number | bigint | null | undefined

export type MoneyOptions = {
  /** Override the formatter's default ISO 4217 currency. */
  currency?: string
  /** Use parentheses for negatives on financial statements. */
  accounting?: boolean
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name'
  notation?: 'standard' | 'compact'
  compactDisplay?: 'short' | 'long'
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  signDisplay?: Intl.NumberFormatOptions['signDisplay']
  useGrouping?: Intl.NumberFormatOptions['useGrouping']
}

export type MoneyFormatter = {
  money: (value: MoneyValue, options?: MoneyOptions) => string
  moneyCompact: (value: MoneyValue, options?: Omit<MoneyOptions, 'notation'>) => string
  currency: string
  locale: string
}

export type DecimalFormatOptions = {
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  notation?: 'standard' | 'compact'
  compactDisplay?: 'short' | 'long'
  signDisplay?: Intl.NumberFormatOptions['signDisplay']
  useGrouping?: Intl.NumberFormatOptions['useGrouping']
}

function normalizedCurrency(value: string): string {
  return value.trim().toUpperCase()
}

type IntlMathematicalValue = number | bigint | string

function numericValue(value: Exclude<MoneyValue, null | undefined>): IntlMathematicalValue | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string') {
    const exact = value.trim()
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(exact)) return null
    return /^-0(?:\.0*)?(?:[eE][-+]?\d+)?$/.test(exact) ? '0' : exact
  }
  if (!Number.isFinite(value)) return null
  // Avoid the surprising "-$0.00" representation for an actual negative zero.
  return Object.is(value, -0) ? 0 : value
}

/**
 * ICU emits U+202F (narrow no-break space) as the grouping separator for fr
 * and a few other locales, but Chromium renders it zero-width in a system-ui
 * stack (fr amounts read ungrouped while the DOM stays
 * correct). Normalize to the universally rendered U+00A0 — still
 * non-breaking, and the pre-CLDR-38 fr convention.
 */
function visibleSpaces(formatted: string): string {
  return formatted.replace(/\u202f/g, '\u00a0')
}


function decimalFallback(
  value: IntlMathematicalValue,
  locale: string,
  options: MoneyOptions,
): string {
  return visibleSpaces(new Intl.NumberFormat(locale, {
    style: 'decimal',
    notation: options.notation,
    compactDisplay: options.compactDisplay,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
    signDisplay: options.signDisplay,
    useGrouping: options.useGrouping,
  }).format(value as never))
}

/**
 * Currency minor units (hundredths of the major unit, as the engine's
 * toCents produces) to an exact major-unit decimal string for the money
 * formatter. Legacy callers without a registry precision stay explicitly on
 * 2; callers with a currency use minorToMajorTextUnits below. The
 * conversion itself lives in one tested place: a misplaced separator here
 * is a 100x display error.
 */
export function minorToMajorText(minor: string): string {
  return minorToMajorTextUnits(minor, 2)
}

/**
 * Currency minor units to an exact major-unit decimal string for the money
 * formatter. The precision always comes from the authoritative currencies
 * registry (`minor_units`); unknown or out-of-range precision refuses by
 * name instead of guessing hundredths — guessing misprices BHD 10x and
 * JPY 100x. The decimal-string math is the shared setup primitive, never a
 * second exponent algorithm here.
 */
export function minorToMajorTextUnits(minor: string, minorUnits: number, currency?: string): string {
  const major = minorToMajor(minor, minorUnits)
  if (major !== null) return major
  const code = typeof currency === 'string' && currency.trim() !== '' ? currency.trim().toUpperCase() : null
  if (!Number.isInteger(minorUnits) || (minorUnits as number) < 0 || (minorUnits as number) > 4) {
    throw new Error(
      `unsupported currency precision "${String(minorUnits)}"${code ? ` for ${code}` : ''}: configure minor units for the currency in Setup → Currencies`,
    )
  }
  throw new Error(
    `unreadable minor-unit amount "${minor}"${code ? ` for ${code}` : ''}: the stored value is not numeric; re-import or replay the source event to restore it`,
  )
}

/**
 * Null-returning display conversion for operator surfaces: a missing,
 * malformed, or out-of-range precision (or a non-string minor value) yields
 * null so the caller renders its named notice, never a guessed amount and
 * never a throw that unmounts the surrounding view.
 */
export function tryMinorToMajorTextUnits(minor: unknown, minorUnits: unknown): string | null {
  if (typeof minor !== 'string' || minor.trim() === '') return null
  if (typeof minorUnits !== 'number') return null
  const major = minorToMajor(minor, minorUnits)
  return major
}

/** Locale-aware decimal presentation that preserves exact numeric strings. */
export function formatDecimal(locale: string, value: MoneyValue, options: DecimalFormatOptions = {}): string {
  if (value === null || value === undefined || value === '') return ''
  const number = numericValue(value)
  if (number === null) return String(value)
  const resolvedLocale = Intl.getCanonicalLocales(locale)[0] ?? 'en'
  return visibleSpaces(new Intl.NumberFormat(resolvedLocale, {
    style: 'decimal',
    notation: options.notation,
    compactDisplay: options.compactDisplay,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
    signDisplay: options.signDisplay,
    useGrouping: options.useGrouping,
  }).format(number as never))
}

export function createMoneyFormatter(locale: string, defaultCurrency: string): MoneyFormatter {
  const resolvedLocale = Intl.getCanonicalLocales(locale)[0] ?? 'en'
  const resolvedDefaultCurrency = normalizedCurrency(defaultCurrency)

  const money = (value: MoneyValue, options: MoneyOptions = {}): string => {
    if (value === null || value === undefined || value === '') return ''
    const number = numericValue(value)
    if (number === null) return String(value)

    const currency = normalizedCurrency(options.currency ?? resolvedDefaultCurrency)
    try {
      return visibleSpaces(new Intl.NumberFormat(resolvedLocale, {
        style: 'currency',
        currency,
        currencyDisplay: options.currencyDisplay ?? 'symbol',
        currencySign: options.accounting ? 'accounting' : 'standard',
        notation: options.notation ?? 'standard',
        compactDisplay: options.compactDisplay,
        minimumFractionDigits: options.minimumFractionDigits,
        maximumFractionDigits: options.maximumFractionDigits,
        signDisplay: options.signDisplay,
        useGrouping: options.useGrouping,
      }).format(number as never))
    } catch {
      // Unknown/private currency codes remain identifiable instead of silently
      // becoming dollars. This also keeps partially migrated source data usable.
      return `${decimalFallback(number, resolvedLocale, options)} ${currency}`.trim()
    }
  }

  return {
    locale: resolvedLocale,
    currency: resolvedDefaultCurrency,
    money,
    moneyCompact: (value, options = {}) => money(value, { ...options, notation: 'compact' }),
  }
}
