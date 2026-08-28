'use client'

import { useMoney } from '@/components/money-provider'
import { cmp as compareMoney, div as divideMoney, sum as sumMoney } from '@openbooks/engine/src/money.ts'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@openbooks/ui'
import { toChartNumber } from '../../app/(app)/analytics/_ui/format'

/**
 * Cockpit UI kit — the shared visual language of the domain control centers
 * (AP / AR / Cash). Kept self-contained so the cockpits read as one bespoke
 * system, independent of the analytics dashboards.
 */

export type Accent = 'teal' | 'sky' | 'violet' | 'amber' | 'emerald' | 'red' | 'slate' | 'indigo'

const CHIP: Record<Accent, string> = {
  teal: 'bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/50',
  sky: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/50',
  violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900/50',
  amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/50',
  emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/50',
  red: 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900/50',
  slate: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  indigo: 'bg-indigo-50 text-indigo-600 ring-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:ring-indigo-900/50',
}

const SUB_TONE = {
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
  neutral: 'text-slate-500 dark:text-slate-400',
} as const

/** KPI hero tile — soft icon chip, uppercase label, big value, toned subline. */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = 'teal',
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  accent?: Accent
  tone?: keyof typeof SUB_TONE
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1', CHIP[accent])}>
        <Icon size={20} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
        <p className={cn('truncate text-2xl font-bold tabular-nums', tone === 'negative' ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{value}</p>
        {sub ? <p className={cn('truncate text-xs font-medium', SUB_TONE[tone])}>{sub}</p> : null}
      </div>
    </div>
  )
}

/** Titled card container. */
export function CockpitPanel({
  title,
  icon: Icon,
  hint,
  actions,
  bodyClassName,
  className,
  children,
}: {
  title: string
  icon?: LucideIcon
  hint?: string
  actions?: ReactNode
  bodyClassName?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900', className)}>
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {Icon && <Icon size={15} className="text-slate-400" />}
          {title}
        </h3>
        {actions ? actions : hint ? <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
      </header>
      <div className={cn('flex-1 p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

const BUCKET_COLOR: Record<string, string> = {
  Current: '#10b981',
  '1-30': '#14b8a6',
  '31-60': '#0ea5e9',
  '61-90': '#f59e0b',
  '90+': '#ef4444',
}

/** Aging bucket bars (Current → 90+). */
export function AgingBars({ buckets, accent }: { buckets: { label: string; amount: string }[]; accent: string }) {
  const { moneyCompact } = useMoney()
  const total = sumMoney(buckets.map((b) => b.amount))
  const widthTotal = compareMoney(total, '0.0000') > 0 ? total : '1.0000'
  return (
    <div className="space-y-2.5">
      {buckets.map((b) => (
        <div key={b.label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: BUCKET_COLOR[b.label] }} />
              {b.label}
            </span>
            <span className={cn('tabular-nums', accent)}>{moneyCompact(b.amount)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full rounded-full" style={{ width: `${Math.max(0, toChartNumber(divideMoney(b.amount, widthTotal)) * 100)}%`, backgroundColor: BUCKET_COLOR[b.label] }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Horizontal weekly schedule bars (predicted cash in/out by week). Rows become
 * clickable when `onSelect` is given — e.g. to open the week's transaction drill. */
export function ScheduleBars({
  weeks,
  barClass = 'bg-red-400 dark:bg-red-500',
  onSelect,
}: {
  weeks: { label: string; amount: string }[]
  barClass?: string
  onSelect?: (index: number) => void
}) {
  const { moneyCompact } = useMoney()
  const max = weeks.reduce((current, w) => compareMoney(w.amount, current) > 0 ? w.amount : current, '1.0000')
  return (
    <div className="space-y-1">
      {weeks.map((w, i) => {
        const row = (
          <>
            <span className="w-24 shrink-0 truncate text-xs text-slate-500 dark:text-slate-400">{w.label}</span>
            <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-slate-50 dark:bg-slate-800/50">
              <div className={cn('h-full rounded transition-all', barClass)} style={{ width: `${Math.max(0, toChartNumber(divideMoney(w.amount, max)) * 100)}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{compareMoney(w.amount, '0.0000') > 0 ? moneyCompact(w.amount) : '—'}</span>
          </>
        )
        return onSelect ? (
          <button key={i} type="button" onClick={() => onSelect(i)} className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
            {row}
          </button>
        ) : (
          <div key={i} className="flex items-center gap-3 px-1 py-0.5">{row}</div>
        )
      })}
    </div>
  )
}
