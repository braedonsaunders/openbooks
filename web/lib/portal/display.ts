import { fromUnits } from '@openbooks/engine/money'
import { createMoneyFormatter } from '@/lib/money-format'
import { minorToMajor } from '@/lib/setup/money-fields'

/** Stored-value balances use fixed four-decimal ledger units, independently of ISO precision. */
export function minorDisplay(minor: string, currency: string, locale: string): string {
  return createMoneyFormatter(locale, currency).money(fromUnits(BigInt(minor)))
}

/** Channel amounts use the owning currency's recorded ISO minor-unit precision. */
export function currencyMinorDisplay(minor: string, currency: string, locale: string, exponent: number | null): string | null {
  if (exponent === null) return null
  const major = minorToMajor(minor, exponent)
  return major === null ? null : createMoneyFormatter(locale, currency).money(major, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })
}

/** Exact decimal strings (document totals and balances). */
export function decimalDisplay(amount: string, currency: string, locale: string): string {
  return createMoneyFormatter(locale, currency).money(amount)
}
