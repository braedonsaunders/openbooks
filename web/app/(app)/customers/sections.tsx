import type { ComponentProps } from 'react'
import Link from 'next/link'
import { cn } from '@openbooks/ui'
import { RelationshipsTable } from './RelationshipsTable'

/**
 * The customers cockpit's bespoke panel bodies, extracted from the page.
 *
 * Same division as the purchasing cockpit (see ../purchasing/sections.tsx):
 * ViewSpec composes the grid and the panels; the panel bodies stay components,
 * shared by the page and the widget registry via this file so they cannot drift. Each of
 * these is a handful of one-off markup, and inventing a ViewSpec block for
 * each would grow the vocabulary one page at a time without ever converging.
 *
 * The rail's attention list and directory are NOT duplicated here: the native
 * page's inline markup is byte-identical to the existing `attention-list` and
 * `directory-section` registry widgets, so the spec reuses those directly.
 */

/**
 * The relationships hero, INCLUDING its empty state.
 *
 * The empty case lives here rather than as a conditional pair of blocks in
 * the spec on purpose — expressing "render A when the list is empty,
 * otherwise B" would require a negated conditional, and the language stays
 * free of one. A component that knows how to render itself with no rows is
 * the ordinary answer.
 */
export function RelationshipsSection({
  rows,
  crmEnabled,
  empty,
}: {
  rows: ComponentProps<typeof RelationshipsTable>['rows']
  crmEnabled: boolean
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return <RelationshipsTable rows={rows} crmEnabled={crmEnabled} />
}

export function ArPulse({
  outstanding,
  overdue,
  overdueIsNegative,
  dso,
  labels,
  href,
}: {
  outstanding: string
  overdue: string
  overdueIsNegative: boolean
  dso: string
  labels: { open: string; overdue: string; dso: string; cta: string }
  href: string
}) {
  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-800">
        <div className="px-3 py-2.5 text-center">
          <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{outstanding}</p>
          <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{labels.open}</p>
        </div>
        <div className="px-3 py-2.5 text-center">
          <p
            className={cn(
              'text-sm font-bold tabular-nums',
              overdueIsNegative ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-100',
            )}
          >
            {overdue}
          </p>
          <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{labels.overdue}</p>
        </div>
        <div className="px-3 py-2.5 text-center">
          <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{dso}</p>
          <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{labels.dso}</p>
        </div>
      </div>
      <Link
        href={href as never}
        className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
      >
        {labels.cta} →
      </Link>
    </>
  )
}
