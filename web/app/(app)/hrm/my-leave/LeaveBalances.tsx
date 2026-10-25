'use client'

import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import { useMoney } from '@/components/money-provider'

/**
 * Self-service balance list: TIME balances per leave type and, where banks
 * exist, VALUE balances per plan — each labelled with its unit so the two
 * are never conflated. Time rows carry the entitlement breakdown
 * (entitlement, taken, pending, remaining) priced by the same engine the
 * filing gate uses. Loader-resolved rows; no fetch, no state. Time figures
 * read as plain hours and value banks as money in the organization currency.
 */

export function LeaveBalances({
  balances,
  timeKindLabel,
  valueKindLabel,
  unlimitedLabel,
  entitlementLabel,
  takenLabel,
  pendingLabel,
  remainingLabel,
  serviceStartUnknownLabel,
  empty,
}: {
  balances: {
    leaveTypeCode: string
    kind: 'time' | 'value'
    employmentId: string | null
    scopeLabel: string
    balance: string | null
    unlimited: boolean
    entitlement: string | null
    taken: string | null
    pending: string | null
    remaining: string | null
    serviceStartUnknown?: boolean
  }[]
  timeKindLabel: string
  valueKindLabel: string
  unlimitedLabel: string
  entitlementLabel: string
  takenLabel: string
  pendingLabel: string
  remainingLabel: string
  serviceStartUnknownLabel?: string
  empty: string
}) {
  const { money } = useMoney()
  const hours = (value: string | null) => (value == null ? '—' : canonicalDecimal(value) ?? value)
  const amount = (row: { kind: 'time' | 'value' }, value: string | null) =>
    value == null ? '—' : row.kind === 'value' ? money(value) : hours(value)
  if (balances.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {balances.map((row) => (
        <li
          key={`${row.kind}-${row.employmentId ?? 'party'}-${row.leaveTypeCode}`}
          className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm"
        >
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {row.leaveTypeCode}
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {row.kind === 'time' ? timeKindLabel : valueKindLabel}
            </span>
            <span className="block text-xs font-normal text-slate-400 dark:text-slate-500">{row.scopeLabel}</span>
            {row.kind === 'time' ? (
              <span className="block text-xs font-normal tabular-nums text-slate-400 dark:text-slate-500">
                {entitlementLabel} {hours(row.entitlement)} · {takenLabel} {hours(row.taken)} ·{' '}
                {pendingLabel} {hours(row.pending)} · {remainingLabel} {hours(row.remaining)}
              </span>
            ) : null}
            {row.kind === 'time' && row.serviceStartUnknown && serviceStartUnknownLabel ? (
              <span className="block text-xs font-normal text-amber-600 dark:text-amber-400">
                {serviceStartUnknownLabel}
              </span>
            ) : null}
          </span>
          <span className="tabular-nums text-slate-500 dark:text-slate-400">
            {row.unlimited ? unlimitedLabel : amount(row, row.balance)}
          </span>
        </li>
      ))}
    </ul>
  )
}
