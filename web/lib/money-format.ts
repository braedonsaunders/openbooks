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

function decimalFallback(
  value: IntlMathematicalValue,
  locale: string,
  options: MoneyOptions,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'decimal',
    notation: options.notation,
    compactDisplay: options.compactDisplay,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
    signDisplay: options.signDisplay,
    useGrouping: options.useGrouping,
  }).format(value as never)
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
      return new Intl.NumberFormat(resolvedLocale, {
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
      }).format(number as never)
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
