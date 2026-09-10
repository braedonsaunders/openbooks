import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import { StartRunButton } from './_ui/NewRunButton'
import { RunStatusBadge } from './_ui/run-status'

/**
 * The payroll cockpit's bespoke rail sections, extracted from the page.
 *
 * Same division as the purchasing cockpit: ViewSpec composes the panels and
 * the grid; the panel BODIES are components. The schedule cards carry the one
 * smart action (Start / Resume / Review), the previous-period body carries a
 * conditional badge + link, and the checklist banner carries a translated
 * settings list — each a conditional pair (or triple) that a spec cannot
 * express, so they live here and both render paths share one implementation.
 *
 * Display strings arrive pre-resolved from the loader (./view.ts); these
 * components only compose markup.
 */

export type ScheduleCardAction =
  | { kind: 'resume'; href: string; outline: boolean; label: string }
  | { kind: 'start'; scheduleId: string }

export interface ScheduleCardRow {
  id: string
  name: string
  frequency: string
  periodStart: string
  periodEnd: string
  payDate: string
  employees: string
  runStatus: 'draft' | 'calculated' | 'committed' | null
  net: string | null
  action: ScheduleCardAction | null
}

export interface ScheduleCardLabels {
  frequency: Record<string, string>
  period: string
  payDate: string
  employees: string
  net: string
}

/**
 * One schedule's current-period row: period facts + the smart action.
 *
 * Moved verbatim from page.tsx; the loader resolves every display string
 * before it arrives here, so the native page and the spec render the same
 * component with the same props.
 */
export function ScheduleCard({
  schedule,
  labels,
}: {
  schedule: ScheduleCardRow
  labels: ScheduleCardLabels
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {schedule.name}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {labels.frequency[schedule.id] ?? schedule.frequency}
          </span>
          {schedule.runStatus && <RunStatusBadge status={schedule.runStatus} />}
        </div>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
          <Fact label={labels.period}>
            {schedule.periodStart} – {schedule.periodEnd}
          </Fact>
          <Fact label={labels.payDate}>{schedule.payDate}</Fact>
          <Fact label={labels.employees}>{schedule.employees}</Fact>
          {schedule.net ? <Fact label={labels.net}>{schedule.net}</Fact> : <span aria-hidden />}
        </dl>
      </div>
      <div className="shrink-0">
        {schedule.action?.kind === 'resume' ? (
          <Button variant={schedule.action.outline ? 'outline' : 'default'} size="sm" asChild>
            <Link href={schedule.action.href as never}>
              {schedule.action.label}
              <ArrowRight size={14} aria-hidden />
            </Link>
          </Button>
        ) : schedule.action?.kind === 'start' ? (
          <StartRunButton payScheduleId={schedule.action.scheduleId} />
        ) : null}
      </div>
    </div>
  )
}

export interface PayrollScheduleListProps {
  schedules: ScheduleCardRow[]
  emptyText: string
  showSetupLink: boolean
  setupLabel: string
  labels: ScheduleCardLabels
}

/**
 * The current-period hero body, INCLUDING its empty state.
 *
 * The empty case lives here rather than as a conditional pair of blocks in
 * the spec on purpose — same call the purchasing cockpit made for its hero.
 */
export function PayrollScheduleList({
  schedules,
  emptyText,
  showSetupLink,
  setupLabel,
  labels,
}: PayrollScheduleListProps) {
  if (schedules.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        <p>{emptyText}</p>
        {showSetupLink && (
          <Link
            href={'/admin/setup/payroll?tab=schedules' as never}
            className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {setupLabel}
          </Link>
        )}
      </div>
    )
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800/60">
      {schedules.map((schedule) => (
        <li key={schedule.id}>
          <ScheduleCard schedule={schedule} labels={labels} />
        </li>
      ))}
    </ul>
  )
}

export interface PreviousRunRow {
  periodStart: string
  periodEnd: string
  payDate: string
  net: string
  employees: string
  posted: boolean
  badgeLabel: string
  href: string
  documentNumber: string
}

export interface PayrollPreviousRunProps {
  run: PreviousRunRow | null
  periodLabel: string
  payDateLabel: string
  netLabel: string
  employeesLabel: string
  noneText: string
}

/** The previous completed period, INCLUDING its empty state. */
export function PayrollPreviousRun({
  run,
  periodLabel,
  payDateLabel,
  netLabel,
  employeesLabel,
  noneText,
}: PayrollPreviousRunProps) {
  if (!run) {
    return <p className="py-2 text-center text-sm text-slate-400 dark:text-slate-500">{noneText}</p>
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-4">
        <Fact label={periodLabel}>
          {run.periodStart} – {run.periodEnd}
        </Fact>
        <Fact label={payDateLabel}>{run.payDate}</Fact>
        <Fact label={netLabel}>{run.net}</Fact>
        <Fact label={employeesLabel}>{run.employees}</Fact>
      </dl>
      <div className="flex items-center gap-3">
        <Badge variant={run.posted ? 'success' : 'default'}>{run.badgeLabel}</Badge>
        <Link
          href={run.href as never}
          className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {run.documentNumber}
          <ArrowRight size={13} aria-hidden />
        </Link>
      </div>
    </div>
  )
}

export interface PayrollChecklistBannerProps {
  text: string
  settings: string
  openSettingsLabel: string
}

/** The setup-checklist banner. Presence-gated by the spec; content is data. */
export function PayrollChecklistBanner({
  text,
  settings,
  openSettingsLabel,
}: PayrollChecklistBannerProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
      <AlertTriangle size={16} aria-hidden />
      <span className="flex-1">
        {text} {settings}
      </span>
      <Button asChild size="sm" variant="outline">
        <Link href={'/admin/setup/payroll?tab=accounts' as never}>{openSettingsLabel}</Link>
      </Button>
    </div>
  )
}

export interface PayrollManageLinksProps {
  paySchedulesLabel: string
  payComponentsLabel: string
}

/** The manage-only setup links under the directory. Presence-gated by the spec. */
export function PayrollManageLinks({
  paySchedulesLabel,
  payComponentsLabel,
}: PayrollManageLinksProps) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs">
      <Link
        href={'/admin/setup/payroll?tab=schedules' as never}
        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
      >
        {paySchedulesLabel}
      </Link>
      <span className="text-slate-300 dark:text-slate-700">·</span>
      <Link
        href={'/admin/setup/payroll?tab=components' as never}
        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
      >
        {payComponentsLabel}
      </Link>
    </div>
  )
}

export function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </dt>
      <dd className="font-medium whitespace-nowrap text-slate-700 tabular-nums dark:text-slate-200">
        {children}
      </dd>
    </div>
  )
}

export function ExceptionRow({
  href,
  tone,
  text,
}: {
  href: string
  tone: 'negative' | 'warning' | 'neutral'
  text: string
}) {
  return (
    <li>
      <Link
        href={href as never}
        className="flex items-start gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <span
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            tone === 'negative' ? 'bg-red-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-teal-500',
          )}
        />
        <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">{text}</span>
      </Link>
    </li>
  )
}
