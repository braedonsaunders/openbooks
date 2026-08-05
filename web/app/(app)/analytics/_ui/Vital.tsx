'use client'

import type { LucideIcon } from 'lucide-react'
import { cn } from '@openbooks/ui'

/**
 * Gradient-ring vital tile — the cashflow dashboard's signature stat card
 * (Burn Rate, AR Coverage, Cash Cycle…), shared by the analytics overview and
 * the Cash cockpit. Moved verbatim from CashflowView.
 */
export function Vital({
  icon: Icon,
  ring,
  label,
  value,
  hint,
  badge,
  split,
  status,
}: {
  icon: LucideIcon
  ring: string
  label: string
  value: string
  hint: string
  badge?: string
  split?: boolean
  status?: string
}) {
  const hintTone =
    status === 'critical'
      ? 'text-red-600 dark:text-red-400'
      : status === 'caution'
        ? 'text-amber-600 dark:text-amber-400'
        : status === 'healthy'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-slate-400 dark:text-slate-500'
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <span className={cn('grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br text-white', ring)}><Icon size={16} /></span>
        {badge ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{badge}</span> : null}
      </div>
      <p className="mt-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
      <p className={cn('text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100', split && 'tracking-tight')}>{value}</p>
      <p className={cn('text-[11px]', hintTone)}>{hint}</p>
    </div>
  )
}
