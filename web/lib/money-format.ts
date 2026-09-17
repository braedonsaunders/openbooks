/**
 * Locale-aware monetary presentation.
 *
 * Currency is always an ISO 4217 code supplied by the owning document,
 * subsidiary, or organization. Locale only controls presentation; it must
 * never be used to guess the currency.
 */

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
 * stack (F-x6-001 item 5: fr amounts read ungrouped while the DOM stays
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
