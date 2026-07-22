'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useLocale } from 'next-intl'
import { createMoneyFormatter, type MoneyFormatter } from '../lib/money-format'

const CurrencyContext = createContext<string | null>(null)

export function MoneyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>
}

/** Locale comes from next-intl; currency comes from the authenticated org. */
export function useMoney(): MoneyFormatter {
  const locale = useLocale()
  const currency = useContext(CurrencyContext)
  if (!currency) throw new Error('useMoney must be used inside MoneyProvider')
  return useMemo(() => createMoneyFormatter(locale, currency), [locale, currency])
}
