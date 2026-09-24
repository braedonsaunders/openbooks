'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { mergeHref } from '@/lib/list-params'

/**
 * The page-size choice for a server-paged house list — the control the
 * registry lists never needed (their saved view owns `perPage`) and the
 * hand-built ones never had, so every operator list was stuck at whatever
 * its loader hardcoded.
 *
 * A client component deliberately: list pages are server trees but record
 * detail pages (the user grants sub-list) render their tables from client
 * components, and one control must serve both. It is still server-STATE:
 * plain links, the same mechanism as SortTh and FilterChips. The size
 * travels on `?perPage=` (parsed by parseListParams, clamped 5–100), the
 * page resets to 1, and every other list param rides along through
 * mergeHref — so search, filters and sort survive a size change. Sub-tables
 * sharing a route pass their prefixed keys.
 */
export function PerPageSelect({
  basePath,
  currentParams,
  perPage,
  options = [25, 50, 100],
  paramKey = 'perPage',
  pageParamKey = 'page',
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  perPage: number
  options?: number[]
  /** URL param carrying the size. Sub-tables pass a prefixed key. */
  paramKey?: string
  /** Pagination param reset when the size changes. */
  pageParamKey?: string
}) {
  const t = useTranslations('ui')
  const label = t('pagination.perPage')
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="flex overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      >
        {options.map((option) => {
          const active = option === perPage
          const href = mergeHref(basePath, currentParams, {
            [paramKey]: option,
            [pageParamKey]: 1,
          })
          return active ? (
            <span
              key={option}
              aria-current="true"
              className="bg-teal-50 px-2.5 py-1.5 text-xs font-semibold text-teal-800 tabular-nums dark:bg-teal-950/50 dark:text-teal-300"
            >
              {option}
            </span>
          ) : (
            <Link
              key={option}
              href={href as never}
              className={cn(
                'px-2.5 py-1.5 text-xs text-slate-700 tabular-nums transition-colors hover:bg-slate-50 hover:text-slate-900',
                'dark:text-slate-200 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
              )}
            >
              {option}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
