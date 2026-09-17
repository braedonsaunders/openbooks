'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Select } from '@openbooks/ui'

export interface CurrencyOption {
  value: string
  label: string
}

/**
 * Reporting-currency selector plus "convert from" basis toggle for aging.
 * Both write plain URL params (`currency`, `currencyBasis`) so the report,
 * its export, and its drill-downs all read the same selection — nothing
 * about the basis lives in component state where an export could lose it.
 * Deliberately NOT the shared filter bar's `basis` (accrual/cash): that word
 * is taken, so this control is always labelled "convert from".
 */
export function CurrencyBasisControl({
  currencies,
  currency,
  currencyBasis,
  currencyLabel,
  basisLabel,
  baseLabel,
  transactionLabel,
}: {
  currencies: CurrencyOption[]
  currency: string
  currencyBasis: 'base' | 'transaction'
  currencyLabel: string
  basisLabel: string
  baseLabel: string
  transactionLabel: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set(key, value)
    router.push(`${pathname}?${next.toString()}`)
  }
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-sm">
        <span className="text-slate-500 dark:text-slate-400">{currencyLabel}</span>
        <Select
          value={currency}
          onChange={(e) => setParam('currency', e.target.value)}
          className="h-8 w-24"
          aria-label={currencyLabel}
        >
          {currencies.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-1 text-sm">
        <span className="text-slate-500 dark:text-slate-400">{basisLabel}</span>
        <Select
          value={currencyBasis}
          onChange={(e) => setParam('currencyBasis', e.target.value)}
          className="h-8 w-40"
          aria-label={basisLabel}
        >
          <option value="base">{baseLabel}</option>
          <option value="transaction">{transactionLabel}</option>
        </Select>
      </label>
    </div>
  )
}
