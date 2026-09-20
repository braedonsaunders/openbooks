'use client'

/**
 * Self-service balance list: TIME balances per leave type and, where banks
 * exist, VALUE balances per plan — each labelled with its unit so the two
 * are never conflated. Loader-resolved rows; no fetch, no state.
 */

export function LeaveBalances({
  balances,
  timeKindLabel,
  valueKindLabel,
  unlimitedLabel,
  empty,
}: {
  balances: { leaveTypeCode: string; kind: 'time' | 'value'; balance: string | null; unlimited: boolean }[]
  timeKindLabel: string
  valueKindLabel: string
  unlimitedLabel: string
  empty: string
}) {
  if (balances.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {balances.map((row) => (
        <li
          key={`${row.kind}-${row.leaveTypeCode}`}
          className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm"
        >
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {row.leaveTypeCode}
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {row.kind === 'time' ? timeKindLabel : valueKindLabel}
            </span>
          </span>
          <span className="tabular-nums text-slate-500 dark:text-slate-400">
            {row.unlimited ? unlimitedLabel : (row.balance ?? '—')}
          </span>
        </li>
      ))}
    </ul>
  )
}
