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
import { cn } from '@openbooks/ui'
import { PartyAvatar } from '../../../components/party-avatar'

/* --- Shared cockpit pieces ------------------------------------------------ */

/** Initials avatar for a person row, shared with every party surface. */
export function PersonAvatar({ name, className }: { name: string | null; className?: string }) {
  return <PartyAvatar name={name} className={className} />
}

const CHIP_TONES = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  positive: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  negative: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  accent: 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
} as const

type ChipTone = keyof typeof CHIP_TONES

function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold', CHIP_TONES[tone])}>
      {children}
    </span>
  )
}

function PersonName({ name, partyId, fallback }: { name: string | null; partyId: string | null; fallback: string }) {
  if (!partyId) return <>{name ?? fallback}</>
  return (
    <Link href={`/entities/employees?party=${partyId}` as never} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
      {name ?? fallback}
    </Link>
  )
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{children}</p>
}

function QueueLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href as never}
      className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
    >
      {label} →
    </Link>
  )
}

export type HrmPulseFigure = {
  label: string
  value: string
  tone?: 'neutral' | 'positive' | 'warning' | 'negative'
}

const PULSE_VALUE_TONE = {
  neutral: 'text-slate-900 dark:text-slate-100',
  positive: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  negative: 'text-red-600 dark:text-red-400',
} as const

const PULSE_COLUMNS = ['grid-cols-1', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'] as const

/**
 * A strip of loader-resolved figures side by side — the receivables-pulse
 * idiom of the customers cockpit. Values arrive formatted; the strip only
 * lays them out and tones them.
 */
export function HrmPulse({ figures, href, cta }: { figures: HrmPulseFigure[]; href?: string | null; cta?: string | null }) {
  if (figures.length === 0) return null
  return (
    <>
      <div
        className={cn(
          'grid divide-x divide-slate-100 dark:divide-slate-800',
          PULSE_COLUMNS[Math.min(figures.length, PULSE_COLUMNS.length - 1)],
        )}
      >
        {figures.map((figure) => (
          <div key={figure.label} className="min-w-0 px-2 py-3 text-center sm:px-3">
            <p className={cn('text-xl font-bold break-words tabular-nums', PULSE_VALUE_TONE[figure.tone ?? 'neutral'])}>
              {figure.value}
            </p>
            <p className="mt-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
              {figure.label}
            </p>
          </div>
        ))}
      </div>
      {href && cta ? <QueueLink href={href} label={cta} /> : null}
    </>
  )
}

export type HrmMixRow = {
  id?: string
  subsidiary: string
  departmentLabel?: string
  headcountLabel?: string
  shareLabel?: string
  /** The row's fraction of today's headcount, 0..1 — a bar width, never a figure. */
  share?: number
  href?: string | null
}

const MIX_BARS = [
  'bg-teal-500',
  'bg-indigo-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-orange-500',
] as const

/**
 * Headcount by department as share bars, largest first. The employer line
 * renders only for an organization that runs more than one subsidiary; a
 * single-entity org sees departments alone.
 */
export function HrmHeadcountMix({
  rows,
  showEmployer,
  title,
  empty,
  totalLabel,
  totalValue,
}: {
  rows: HrmMixRow[]
  showEmployer: boolean
  title: string
  empty: string
  totalLabel: string
  totalValue: string
}) {
  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-1">
        <h4 className="text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{title}</h4>
        {rows.length > 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {totalLabel} <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{totalValue}</span>
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyLine>{empty}</EmptyLine>
      ) : (
        <ul className="space-y-3 px-4 pt-2 pb-4">
          {rows.map((row, i) => {
            const label = row.departmentLabel ?? ''
            return (
              <li key={row.id ?? `${row.subsidiary}-${label}`}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', MIX_BARS[i % MIX_BARS.length])} />
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                      {row.href ? (
                        <Link href={row.href as never} className="hover:underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                    </span>
                    {showEmployer ? (
                      <span className="truncate text-xs text-slate-400 dark:text-slate-500">{row.subsidiary}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{row.headcountLabel}</span>
                    {row.shareLabel ? (
                      <span className="ml-2 inline-block w-10 text-right text-xs text-slate-400 dark:text-slate-500">{row.shareLabel}</span>
                    ) : null}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={cn('h-full rounded-full', MIX_BARS[i % MIX_BARS.length])}
                    style={{ width: `${Math.max(0, Math.min(1, row.share ?? 0)) * 100}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export type OnboardingPanelItem = {
  worker: string
  title: string
  dueOn: string
}

/**
 * Onboarding panel for the HR cockpit: open checklist counts plus the
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
  noDueSoon,
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
  /** Shown when checklists are open but no step is overdue or due soon:
   * the generic `empty` would contradict the count above it. */
  noDueSoon: string
  viewAll: string
  viewAllHref: string
}) {
  if (openCount === 0) {
    return <EmptyLine>{empty}</EmptyLine>
  }
  const rows = [
    ...overdue.map((item) => ({ ...item, tone: 'overdue' as const })),
    ...upcoming.map((item) => ({ ...item, tone: 'upcoming' as const })),
  ]
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{openCount}</p>
        <p className="text-xs font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{openLabel}</p>
        {overdue.length > 0 ? (
          <span className="ml-auto">
            <Chip tone="negative">
              {overdueLabel} · {overdue.length}
            </Chip>
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-slate-100 px-4 py-3 text-sm text-slate-400 dark:border-slate-800 dark:text-slate-500">{noDueSoon}</p>
      ) : (
        <ul className="divide-y divide-slate-50 border-t border-slate-100 dark:divide-slate-800/60 dark:border-slate-800">
          {rows.slice(0, 7).map((row, i) => (
            <li key={`${row.worker}-${row.title}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
              <PersonAvatar name={row.worker} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{row.title}</p>
                <p className="truncate text-xs text-slate-400 dark:text-slate-500">{row.worker}</p>
              </div>
              <Chip tone={row.tone === 'overdue' ? 'negative' : 'neutral'}>
                {row.tone === 'overdue' ? overdueLabel : upcomingLabel} · {row.dueOn}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <a
        href={viewAllHref}
        className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
      >
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
    return <EmptyLine>{empty}</EmptyLine>
  }
  return (
    <div>
      <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
            <PersonAvatar name={item.employeeName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                <PersonName name={item.employeeName} partyId={item.partyId} fallback={notAvailable} />
              </p>
              <p className="mt-0.5 truncate text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.effectiveLabel}</p>
            </div>
            <Chip tone="accent">{item.kindLabel}</Chip>
            <Chip tone="warning">{item.statusLabel}</Chip>
          </li>
        ))}
      </ul>
      <QueueLink href={viewAllHref} label={viewAllLabel} />
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
  const half = (title: string, empty: string, items: HrmUpcomingItem[], tone: 'positive' | 'negative'): ReactNode => (
    <div>
      <h4 className="flex items-center justify-between gap-2 px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
        <span className="flex items-center gap-2">
          <span className={cn('inline-block h-2 w-2 rounded-full', tone === 'positive' ? 'bg-emerald-500' : 'bg-rose-500')} />
          {title}
        </span>
        <Chip tone={items.length > 0 ? tone : 'neutral'}>{items.length}</Chip>
      </h4>
      {items.length === 0 ? (
        <p className="px-4 py-2.5 text-sm text-slate-400 dark:text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {items.map((item, i) => (
            <li key={`${item.partyId ?? item.name ?? ''}-${i}`} className="flex items-center gap-3 px-4 py-2">
              <PersonAvatar name={item.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                  <PersonName name={item.name} partyId={item.partyId} fallback={notAvailable} />
                </p>
                <p className="truncate text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <div className="pb-2">
      {half(startsTitle, startsEmpty, starts, 'positive')}
      {half(endsTitle, endsEmpty, ends, 'negative')}
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
 * aggregate evidence trail, newest first, drawn as a timeline. Empty names
 * the gap instead of rendering a blank panel.
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
    return <EmptyLine>{empty}</EmptyLine>
  }
  return (
    <ol className="px-4 py-3">
      {items.map((item, i) => (
        <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
          {i < items.length - 1 ? (
            <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px bg-slate-200 dark:bg-slate-800" />
          ) : null}
          <PersonAvatar name={item.name} className="relative ring-4 ring-white dark:ring-slate-900" />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
              <PersonName name={item.name} partyId={item.partyId} fallback={notAvailable} />
              <Chip>{item.kindLabel}</Chip>
            </p>
            <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{item.reason}</p>
            <p className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">{item.recordedAt}</p>
          </div>
        </li>
      ))}
    </ol>
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
        <EmptyLine>{empty}</EmptyLine>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <PersonAvatar name={item.workerName} />
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 dark:text-slate-200">{item.workerName}</p>
              <Chip tone="accent">{item.leaveTypeCode}</Chip>
              <span className="w-12 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{item.hours}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-center justify-center gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {pendingLabel}
        <Chip tone={pendingCount > 0 ? 'warning' : 'neutral'}>{pendingCount}</Chip>
      </p>
      <QueueLink href={queueHref} label={viewAllLabel} />
    </div>
  )
}

export type HrmRecruitingPanelFigure = {
  label: string
  value: string
}

/**
 * Recruiting panel: the funnel figures as a pulse strip beside the queue
 * link — open requisitions, offers awaiting response, interviews this week.
 * All values arrive loader-resolved as strings.
 */
export function HrmRecruitingPanel({
  figures,
  empty,
  viewAll,
  viewAllHref,
}: {
  figures: HrmRecruitingPanelFigure[]
  empty?: string
  viewAll: string
  viewAllHref: string
}) {
  if (figures.length === 0) {
    return (
      <div>
        <EmptyLine>{empty}</EmptyLine>
        <QueueLink href={viewAllHref} label={viewAll} />
      </div>
    )
  }
  return <HrmPulse figures={figures} href={viewAllHref} cta={viewAll} />
}

export type HrmBenefitsPanelWindow = {
  id: string
  name: string
}

/** Benefits panel: open windows plus pending-approval and missing-input counts beside the queue link. */
export function HrmBenefitsPanel({
  openWindows,
  openLabel,
  openEmpty,
  pendingCount,
  pendingLabel,
  missingCount,
  missingLabel,
  queueHref,
  viewAllLabel,
}: {
  openWindows: HrmBenefitsPanelWindow[]
  openLabel: string
  openEmpty: string
  pendingCount: number
  pendingLabel: string
  missingCount: number
  missingLabel: string
  queueHref: string
  viewAllLabel: string
}) {
  return (
    <div>
      <HrmPulse
        figures={[
          { label: pendingLabel, value: String(pendingCount), tone: pendingCount > 0 ? 'warning' : 'neutral' },
          { label: missingLabel, value: String(missingCount), tone: missingCount > 0 ? 'negative' : 'neutral' },
        ]}
      />
      {openWindows.length === 0 ? (
        <p className="border-t border-slate-100 px-4 py-4 text-center text-sm text-slate-400 dark:border-slate-800 dark:text-slate-500">
          {openEmpty}
        </p>
      ) : (
        <ul className="divide-y divide-slate-50 border-t border-slate-100 dark:divide-slate-800/60 dark:border-slate-800">
          {openWindows.map((window) => (
            <li key={window.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{window.name}</p>
              <Chip tone="positive">{openLabel}</Chip>
            </li>
          ))}
        </ul>
      )}
      <QueueLink href={queueHref} label={viewAllLabel} />
    </div>
  )
}
