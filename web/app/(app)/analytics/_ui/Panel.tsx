'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@openbooks/ui'

/** Titled card container used across every analytics tab. */
export function Panel({
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
        {hint && !actions && <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
        {actions}
      </header>
      <div className={cn('flex-1 p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Small segmented toggle used for chart/metric switches inside panels. */
export function SegToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.value
              ? 'bg-white text-teal-600 shadow-sm dark:bg-slate-700 dark:text-teal-300'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
