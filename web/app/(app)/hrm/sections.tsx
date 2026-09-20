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

export type OnboardingPanelItem = {
  worker: string
  title: string
  dueOn: string
}

/**
 * Onboarding panel for the HR cockpit rail: open checklist counts plus the
 * overdue steps and the next seven days, all resolved by the loader through
 * the canonical process read service. The panel links to the processes tab;
 * the checklist itself lives there, never as a second copy here.
 */
export function OnboardingPanel({
  openCount,
  overdue,
  upcoming,
  openLabel,
  overdueLabel,
  upcomingLabel,
  empty,
  viewAll,
  viewAllHref,
}: {
  openCount: number
  overdue: OnboardingPanelItem[]
  upcoming: OnboardingPanelItem[]
  openLabel: string
  overdueLabel: string
  upcomingLabel: string
  empty: string
  viewAll: string
  viewAllHref: string
}) {
  if (openCount === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  const rows = [
    ...overdue.map((item) => ({ ...item, tone: 'overdue' as const })),
    ...upcoming.map((item) => ({ ...item, tone: 'upcoming' as const })),
  ]
  return (
    <div className="px-4 py-3">
      <p className="text-sm text-slate-500 dark:text-slate-400">{openLabel}</p>
      <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{openCount}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.slice(0, 7).map((row, i) => (
            <li key={`${row.worker}-${row.title}-${i}`} className="text-sm">
              <span
                className={
                  row.tone === 'overdue'
                    ? 'font-medium text-red-700 dark:text-red-300'
                    : 'font-medium text-slate-700 dark:text-slate-200'
                }
              >
                {row.tone === 'overdue' ? overdueLabel : upcomingLabel} · {row.dueOn}
              </span>{' '}
              <span className="text-slate-500 dark:text-slate-400">
                {row.title} — {row.worker}
              </span>
            </li>
          ))}
        </ul>
      )}
      <a href={viewAllHref} className="mt-3 inline-block text-sm font-medium text-teal-700 dark:text-teal-300">
        {viewAll}
      </a>
    </div>
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

export type HrmLeavePanelItem = {
  workerName: string
  leaveTypeCode: string
  hours: string
}

/**
 * Leave panel: who is on leave today plus the pending-approval count,
 * beside the queue link. Empty names the quiet day instead of rendering a
 * blank panel.
 */
export function HrmLeavePanel({
  items,
  empty,
  pendingCount,
  pendingLabel,
  queueHref,
  viewAllLabel,
}: {
  items: HrmLeavePanelItem[]
  empty: string
  pendingCount: number
  pendingLabel: string
  queueHref: string
  viewAllLabel: string
}) {
  return (
    <div>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {items.map((item, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {item.workerName}{' '}
                <span className="font-normal text-slate-400 dark:text-slate-500">· {item.leaveTypeCode}</span>
              </p>
              <p className="text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.hours}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-slate-100 px-4 py-2.5 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {pendingLabel} <span className="font-semibold tabular-nums">{pendingCount}</span>
      </p>
      <Link
        href={queueHref as never}
        className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
      >
        {viewAllLabel} →
      </Link>
    </div>
  )
}
