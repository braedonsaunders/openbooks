'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useLocale } from 'next-intl'
import { createMoneyFormatter, type MoneyFormatter } from '../lib/money-format'

const CurrencyContext = createContext<string | null>(null)

export function MoneyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>
}

/** Locale comes from next-intl; records may override the organization currency. */
export function useMoney(recordCurrency?: string): MoneyFormatter {
  const locale = useLocale()
  const orgCurrency = useContext(CurrencyContext)
  const currency = recordCurrency ?? orgCurrency
  if (!currency) throw new Error('useMoney must be used inside MoneyProvider')
  return useMemo(() => createMoneyFormatter(locale, currency), [locale, currency])
}
