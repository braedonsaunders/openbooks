'use client'

import type { LucideIcon } from 'lucide-react'
import { cn } from '@openbooks/ui'

export type KpiAccent = 'teal' | 'sky' | 'violet' | 'amber' | 'emerald' | 'red' | 'slate'

const ACCENT: Record<KpiAccent, string> = {
  teal: 'bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/50',
  sky: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/50',
  violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900/50',
  amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/50',
  emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/50',
  red: 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900/50',
  slate: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
}

const SUB_TONE = {
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-red-600 dark:text-red-400',
  neutral: 'text-slate-500 dark:text-slate-400',
} as const

/**
 * KPI hero tile: soft icon chip on the left, an uppercase label, a large
 * value, and an optional colour-toned subtext line. The row of these sits at
 * the top of every analytics screen.
 */
export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = 'teal',
  tone = 'neutral',
  className,
}: {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  accent?: KpiAccent
  tone?: 'positive' | 'negative' | 'neutral'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1', ACCENT[accent])}>
        <Icon size={20} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
          {label}
        </p>
        <p className="truncate text-2xl font-bold text-slate-900 tabular-nums dark:text-slate-100">{value}</p>
        {sub && <p className={cn('truncate text-xs font-medium', SUB_TONE[tone])}>{sub}</p>}
      </div>
    </div>
  )
}
