import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Compact single-row header for analytics dashboards: an inline
 * "Analytics / <Title> · <period>" breadcrumb on the left and the period /
 * filter control on the right — a third of the height of the stacked
 * PageHeader + filter-bar it replaces.
 */
export function AnalyticsHeader({
  title,
  periodLabel,
  backHref = '/analytics',
  backLabel = 'Analytics',
  children,
}: {
  title: string
  periodLabel?: string
  backHref?: string
  backLabel?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={backHref}
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
        >
          <ArrowLeft size={13} />
          {backLabel}
        </Link>
        <span aria-hidden className="text-slate-300 dark:text-slate-600">
          /
        </span>
        <h1 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        {periodLabel ? (
          <span className="hidden shrink-0 text-xs text-slate-400 sm:inline dark:text-slate-500">· {periodLabel}</span>
        ) : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  )
}
