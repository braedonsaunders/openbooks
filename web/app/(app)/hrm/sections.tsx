/**
 * The HRM cockpit's bespoke sections, extracted from the page.
 *
 * ViewSpec composes the grid and the panels; the panel BODIES stay
 * components, shared by the page and the widget registry via this file so
 * they cannot drift — the same division the purchasing and banking
 * cockpits established (see ../../purchasing/sections.tsx and
 * ../banking/sections.tsx).
 */

import Link from 'next/link'
import type { ReactNode } from 'react'

export type HrmHeadcountRow = {
  subsidiary: string
  department: string | null
  headcount: number
  /** Drill-through to the employee directory filtered to this department
   *  (or its unassigned roster); absent when the viewer may not open it. */
  href?: string | null
}

/**
 * Headcount as-of today by employer subsidiary and department, INCLUDING
 * its empty state. The empty case lives here rather than as a conditional
 * pair of blocks in the spec: a resolved zero is data (nobody in service
 * on the date), and the component that knows how to render itself when it
 * has no rows is the ordinary answer.
 */
export function HrmHeadcountTable({
  groups,
  total,
  employerColumn,
  departmentColumn,
  headcountColumn,
  unassigned,
  empty,
  totalLabel,
}: {
  groups: HrmHeadcountRow[]
  total: number
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  empty: string
  totalLabel: string
}) {
  if (groups.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
        <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          <th className="px-4 py-2 text-left font-medium">{employerColumn}</th>
          <th className="px-3 py-2 text-left font-medium">{departmentColumn}</th>
          <th className="px-4 py-2 text-right font-medium">{headcountColumn}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group, i) => (
          <tr key={`${group.subsidiary}-${group.department ?? ''}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
            <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{group.subsidiary}</td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
              {group.href ? (
                <Link href={group.href as never} className="hover:underline">{group.department ?? unassigned}</Link>
              ) : (
                group.department ?? unassigned
              )}
            </td>
            <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {group.headcount.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-100 dark:border-slate-800">
          <td className="px-4 py-2 font-semibold text-slate-900 dark:text-slate-100" colSpan={2}>
            {totalLabel}
          </td>
          <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.toLocaleString()}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

export type HrmPendingItem = {
  id: string
  employeeName: string | null
  partyId: string | null
  kindLabel: string
  statusLabel: string
  effectiveLabel: string
}

/**
 * Pending change requests: the count plus the five newest, beside the
 * queue link. A scope refusal renders as a refusal with its remedy
 * intact — never an empty list pretending the queue is clear.
 */
export function HrmPendingRequests({
  items,
  empty,
  viewAllHref,
  viewAllLabel,
  refusal,
  notAvailable,
}: {
  items: HrmPendingItem[]
  empty: string
  viewAllHref: string
  viewAllLabel: string
  refusal: string | null
  notAvailable: string
}) {
  if (refusal !== null) {
    return (
      <div role="alert" className="px-4 py-4">
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          {refusal}
        </p>
      </div>
    )
  }
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <div>
      <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
        {items.map((item) => (
          <li key={item.id} className="px-4 py-2.5">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {item.partyId ? (
                <Link href={`/entities/employees?party=${item.partyId}` as never} className="hover:underline">
                  {item.employeeName ?? notAvailable}
                </Link>
              ) : (
                (item.employeeName ?? notAvailable)
              )}
            </p>
            <p className="mt-0.5 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {item.kindLabel} · {item.statusLabel} · {item.effectiveLabel}
            </p>
          </li>
        ))}
      </ul>
      <Link
        href={viewAllHref as never}
        className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
      >
        {viewAllLabel} →
      </Link>
    </div>
  )
}

export type HrmUpcomingItem = {
  name: string | null
  partyId: string | null
  detail: string
}

/**
 * Starts and ends in the next 30 days from the live employment versions.
 * Each half carries its own empty state: an empty half names what is
 * empty (nobody starting, nobody ending), never a blank panel.
 */
export function HrmUpcomingChanges({
  starts,
  ends,
  startsTitle,
  startsEmpty,
  endsTitle,
  endsEmpty,
  notAvailable,
  truncated,
  truncatedNote,
}: {
  starts: HrmUpcomingItem[]
  ends: HrmUpcomingItem[]
  startsTitle: string
  startsEmpty: string
  endsTitle: string
  endsEmpty: string
  notAvailable: string
  truncated: boolean
  truncatedNote: string
}) {
  const person = (item: HrmUpcomingItem): ReactNode =>
    item.partyId ? (
      <Link href={`/entities/employees?party=${item.partyId}` as never} className="hover:underline">
        {item.name ?? notAvailable}
      </Link>
    ) : (
      (item.name ?? notAvailable)
    )
  const half = (title: string, empty: string, items: HrmUpcomingItem[]): ReactNode => (
    <div>
      <h4 className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-400 dark:text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {items.map((item, i) => (
            <li key={`${item.partyId ?? item.name ?? ''}-${i}`} className="px-4 py-2">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{person(item)}</p>
              <p className="text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <div className="pb-2">
      {half(startsTitle, startsEmpty, starts)}
      {half(endsTitle, endsEmpty, ends)}
      {truncated ? (
        <p className="border-t border-slate-100 px-4 py-2.5 text-center text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          {truncatedNote}
        </p>
      ) : null}
    </div>
  )
}

export type HrmRecentChangeItem = {
  name: string | null
  partyId: string | null
  kindLabel: string
  reason: string
  recordedAt: string
}

/**
 * The last recorded employment change events with their reasons — the
 * aggregate evidence trail, newest first. Empty names the gap instead of
 * rendering a blank panel.
 */
export function HrmRecentChanges({
  items,
  empty,
  notAvailable,
}: {
  items: HrmRecentChangeItem[]
  empty: string
  notAvailable: string
}) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {items.map((item, i) => (
        <li key={i} className="px-4 py-2.5">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {item.partyId ? (
              <Link href={`/entities/employees?party=${item.partyId}` as never} className="hover:underline">
                {item.name ?? notAvailable}
              </Link>
            ) : (
              (item.name ?? notAvailable)
            )}{' '}
            <span className="font-normal text-slate-400 dark:text-slate-500">· {item.kindLabel}</span>
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{item.reason}</p>
          <p className="text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.recordedAt}</p>
        </li>
      ))}
    </ul>
  )
}

/**
 * The honesty panel: active employee parties without an employment record
 * are named by count, with the sentence that they are not yet migrated
 * and headcount excludes them, plus the migration article. A fully
 * migrated org renders the healthy state, never a blank panel.
 */
export function HrmReadiness({
  message,
  docHref,
  docLabel,
  tone,
}: {
  message: string
  docHref: string
  docLabel: string
  tone: 'warning' | 'positive'
}) {
  return (
    <div className="space-y-3 px-4 py-4">
      <p
        className={
          tone === 'warning'
            ? 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
            : 'rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
        }
      >
        {message}
      </p>
      <Link
        href={docHref as never}
        className="block text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
      >
        {docLabel} →
      </Link>
    </div>
  )
}
