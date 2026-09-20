import Link from 'next/link'
import { UrlDrawer } from '@openbooks/ui'
import { ProcessChecklistBody } from '../processes-client'
import type { ProcessRow, ProcessSegmentView, ProcessesPageData } from '../../../../lib/hrm/processes-page'

/**
 * Process checklist sections (server components): the segment nav, the
 * checklist table the loader resolved through the canonical process read
 * service, and the URL drawer shell around the shared client checklist
 * body with owners, due dates, evidence, and the complete/skip actions.
 * Every string arrives loader-resolved as props — no org id, user id, or
 * Authz crosses into render. The interactive body stays the client
 * component the page and the widget registry share via this file so they
 * cannot drift.
 */

/** Segments: server-side filter pills with per-segment counts. */
export function ProcessSegments({
  ariaLabel,
  segments,
}: {
  ariaLabel: string
  segments: ProcessSegmentView[]
}) {
  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {segments.map((segment) => (
        <Link
          key={segment.key}
          href={segment.href}
          aria-current={segment.active ? 'page' : undefined}
          className={
            segment.active
              ? 'rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900'
              : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'
          }
        >
          {segment.label} · {segment.count}
        </Link>
      ))}
    </nav>
  )
}

export function ProcessesTable({
  columns,
  rows,
  empty,
}: {
  columns: Record<string, string>
  rows: ProcessRow[]
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
        <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          <th className="px-4 py-2 text-left font-medium">{columns.employee}</th>
          <th className="px-3 py-2 text-left font-medium">{columns.kind}</th>
          <th className="px-3 py-2 text-left font-medium">{columns.effective}</th>
          <th className="px-3 py-2 text-right font-medium">{columns.progress}</th>
          <th className="px-4 py-2 text-right font-medium">{columns.nextDue}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className="border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
          >
            <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">
              <Link href={row.href} className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500">
                {row.workerName}
              </Link>
            </td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.kindLabel}</td>
            <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">{row.effectiveDate}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
              {row.doneRequired}/{row.required}
              {row.overdueBadge !== null ? (
                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                  {row.overdueBadge}
                </span>
              ) : null}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
              {row.nextDueOn ?? '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The checklist flyout shell: a URL drawer around the shared client
 * checklist body that closes by navigation, or the named load failure for
 * a bookmarked id that no longer resolves. Null payload renders nothing —
 * the spec's `when` gate already omits it, so this is the second half of
 * the same guard.
 */
export function ProcessDrawer({
  drawer,
}: {
  drawer: ProcessesPageData['drawer']
}) {
  if (!drawer) return null
  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      title={drawer.title}
      description={drawer.description ?? undefined}
    >
      {drawer.detail ? (
        <ProcessChecklistBody detail={drawer.detail} />
      ) : drawer.missingDetail ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      ) : null}
    </UrlDrawer>
  )
}
