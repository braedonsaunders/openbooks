import type { ComponentProps } from 'react'
import Link from 'next/link'
import { cn } from '@openbooks/ui'
import { LiveDirectory, type DirectoryItem } from '../../../components/module-home/ui'
import { CommitmentsTable } from './CommitmentsTable'

/**
 * The purchasing cockpit's bespoke rail sections, extracted from the page.
 *
 * These exist because the alternative was worse. Each of them is a handful of
 * one-off markup — a three-cell pulse strip, a dotted attention list — and
 * inventing a ViewSpec block for each would grow the vocabulary one page at a
 * time without ever converging. Extracting them instead means the native page
 * and the spec render the SAME component rather than two hand-kept copies, so
 * they cannot drift.
 *
 * The division that emerged from this page is worth stating: on a cockpit,
 * ViewSpec composes the panels and the grid; the panel BODIES are components.
 * That is still the useful boundary — panels can be reordered, removed, or
 * added without touching code — but it is a weaker claim than a list page,
 * where the whole surface really is expressible.
 */

/**
 * The commitments hero, INCLUDING its empty state.
 *
 * The empty case lives here rather than as a conditional pair of blocks in the
 * spec on purpose. Expressing "render A when the list is empty, otherwise B"
 * would require the spec language to gain a negated conditional, and once it
 * has one of those the argument against arithmetic and comparisons gets much
 * weaker. A component that knows how to render itself when it has no rows is
 * the ordinary answer.
 */
export function CommitmentsSection({
  rows,
  showPurchaseOrders,
  empty,
}: {
  rows: ComponentProps<typeof CommitmentsTable>['rows']
  showPurchaseOrders: boolean
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return <CommitmentsTable rows={rows} showPurchaseOrders={showPurchaseOrders} />
}

export function ApPulse({
  outstanding,
  overdue,
  dueNext7,
  overdueIsNegative,
  labels,
  href,
}: {
  outstanding: string
  overdue: string
  dueNext7: string
  overdueIsNegative: boolean
  labels: { open: string; overdue: string; due7: string; cta: string }
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
          <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{dueNext7}</p>
          <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{labels.due7}</p>
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

export type AttentionItem = { tone: 'negative' | 'warning'; text: string; href: string }

export function AttentionList({ items, allClear }: { items: AttentionItem[]; allClear: string }) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{allClear}</p>
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {items.map((item, i) => (
        <li key={i}>
          <Link
            href={item.href as never}
            className="flex items-start gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <span
              className={cn(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                item.tone === 'negative' ? 'bg-red-500' : 'bg-amber-500',
              )}
            />
            <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">{item.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function DirectorySection({ items, title }: { items: DirectoryItem[]; title: string }) {
  if (items.length === 0) return null
  return (
    <div className="shrink-0">
      <h3 className="mb-2 px-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
      <LiveDirectory items={items} />
    </div>
  )
}
