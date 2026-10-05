import { fromUnits } from '@openbooks/engine/money'
import { createMoneyFormatter } from '@/lib/money-format'

/** Minor-unit integer strings (channel totals, stored-value balances). */
export function minorDisplay(minor: string, currency: string, locale: string): string {
  return createMoneyFormatter(locale, currency).money(fromUnits(BigInt(minor)))
}

/** Exact decimal strings (document totals and balances). */
export function decimalDisplay(amount: string, currency: string, locale: string): string {
  return createMoneyFormatter(locale, currency).money(amount)
}
