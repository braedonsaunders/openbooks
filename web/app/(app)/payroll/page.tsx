import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { payrollHome, type PayrollScheduleCard } from '../../../lib/module-home/payroll'
import { StartRunButton } from './_ui/NewRunButton'
import { RunStatusBadge } from './_ui/run-status'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return { title: t('title') }
}

/**
 * Payroll module home — the landing cockpit. The per-schedule current-period
 * cards are the hero (period, pay date, and the one smart action: Start /
 * Resume / Review), flanked by YTD vitals, the previous completed period, the
 * exception queues (missing profiles / wages — surfaced BEFORE a run trips on
 * them), and the live directory. Employees live on the NATIVE entity list
 * (/entities/employees) — payroll deliberately has no second roster; profiles
 * are a tab on the employee drawer.
 */
export default async function PayrollHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const canManage = can(authz, 'payroll.manage')
  const t = await getTranslations('payroll')
  const { money, moneyCompact } = await getMoneyFormatter()
  void (await searchParams)

  const home = await payrollHome(orgId)
  const tabs = await groupTabs('payroll', '/payroll')

  const header = (
    <PageHeader
      title={t('title')}
      description={t('description')}
      actions={<ModuleHomeTabs tabs={tabs} />}
    />
  )

  // ---- Overview ----
  const directory: DirectoryItem[] = [
    {
      href: '/payroll/runs',
      label: t('home.directory.runs'),
      iconKey: 'list-checks',
      badge: {
        value: String(home.inProgressRuns),
        hint: t('home.directory.runsHint', { total: home.totalRuns }),
        tone: home.inProgressRuns > 0 ? 'warning' : 'neutral',
      },
    },
    ...(canManage
      ? [
          {
            href: '/entities/employees',
            label: t('home.directory.employees'),
            iconKey: 'users',
            badge: { value: String(home.activeEmployees), hint: t('home.directory.employeesHint') },
          },
          {
            href: '/admin/setup/payroll',
            label: t('home.directory.setup'),
            iconKey: 'settings',
            badge:
              home.missingSettings.length > 0
                ? {
                    value: String(home.missingSettings.length),
                    hint: t('home.directory.setupHint'),
                    tone: 'warning' as const,
                  }
                : undefined,
          },
        ]
      : []),
  ]

  const exceptionCount =
    home.exceptions.missingProfilesTotal + home.exceptions.missingWagesTotal

  return (
    <ListPageLayout header={header}>
      <div className="flex flex-col gap-4">
        {canManage && home.missingSettings.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle size={16} aria-hidden />
            <span className="flex-1">
              {t('checklist.incomplete', { count: home.missingSettings.length })}{' '}
              {home.missingSettings.map((key) => t(`settingsPage.fields.${key}`)).join(', ')}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={'/admin/setup/payroll?tab=accounts' as never}>{t('checklist.openSettings')}</Link>
            </Button>
          </div>
        )}

        {/* Vitals */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <HomeStatTile
            icon="users"
            accent="indigo"
            label={t('home.vitals.employees')}
            value={home.activeEmployees.toLocaleString()}
            sub={t('home.vitals.employeesSub')}
          />
          <HomeStatTile
            icon="check-circle"
            accent="teal"
            label={t('home.vitals.periodsRan', { year: home.taxYear })}
            value={
              home.defaultPeriodsPerYear
                ? t('home.vitals.periodsOf', { ran: home.runsThisYear, total: home.defaultPeriodsPerYear })
                : home.runsThisYear.toLocaleString()
            }
            sub={t('home.vitals.periodsRanSub')}
          />
          <HomeStatTile
            icon="badge-dollar"
            accent="violet"
            label={t('home.vitals.ytdGross')}
            value={moneyCompact(home.ytdGross)}
            sub={t('home.vitals.ytdEmployerCost', { amount: moneyCompact(home.ytdEmployerCost) })}
          />
          <HomeStatTile
            icon="wallet"
            accent="emerald"
            label={t('home.vitals.ytdNet')}
            value={moneyCompact(home.ytdNet)}
            sub={t('home.vitals.ytdNetSub')}
          />
          <HomeStatTile
            icon="calendar-clock"
            accent="amber"
            label={t('home.vitals.nextPayDate')}
            value={home.nextPayDate ? shortDate(home.nextPayDate) : '—'}
            sub={home.nextPayDate ? undefined : t('home.vitals.noSchedule')}
          />
        </div>

        {/* Current periods hero + supporting rail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="flex min-h-0 flex-col gap-5 lg:col-span-2">
            <HomePanel
              title={t('home.current.title')}
              icon="calendar-clock"
              bodyClassName="p-0"
              className="shrink-0"
            >
              {home.schedules.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
                  <p>{t('home.current.noSchedules')}</p>
                  {canManage && (
                    <Link
                      href={'/admin/setup/payroll?tab=schedules' as never}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {t('links.paySchedules')}
                    </Link>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {home.schedules.map((schedule) => (
                    <li key={schedule.id}>
                      <ScheduleCard schedule={schedule} canRun={canRun} t={t} money={money} />
                    </li>
                  ))}
                </ul>
              )}
            </HomePanel>

            <HomePanel title={t('home.previous.title')} icon="check-circle" className="shrink-0">
              {home.previousRun ? (
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                  <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-4">
                    <Fact label={t('columns.period')}>
                      {shortDate(home.previousRun.periodStart)} – {shortDate(home.previousRun.periodEnd)}
                    </Fact>
                    <Fact label={t('columns.payDate')}>{shortDate(home.previousRun.payDate)}</Fact>
                    <Fact label={t('columns.net')}>{money(home.previousRun.netTotal)}</Fact>
                    <Fact label={t('columns.employees')}>{home.previousRun.employeeCount.toLocaleString()}</Fact>
                  </dl>
                  <div className="flex items-center gap-3">
                    <Badge variant={home.previousRun.posted ? 'success' : 'default'}>
                      {t(home.previousRun.posted ? 'status.posted' : 'status.committed')}
                    </Badge>
                    <Link
                      href={`/payroll/runs/${home.previousRun.documentId}` as never}
                      className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {home.previousRun.documentNumber}
                      <ArrowRight size={13} aria-hidden />
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-slate-400 dark:text-slate-500">
                  {t('home.previous.none')}
                </p>
              )}
            </HomePanel>
          </div>

          <div className="flex min-h-0 flex-col gap-5">
            <HomePanel
              title={t('home.exceptions.title')}
              icon="triangle-alert"
              bodyClassName="p-0"
              className="shrink-0"
              hint={exceptionCount > 0 ? String(exceptionCount) : undefined}
            >
              {exceptionCount === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                  {t('home.exceptions.allClear')}
                </p>
              ) : (
                <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
                  {home.exceptions.missingProfiles.map((e) => (
                    <ExceptionRow
                      key={`p-${e.id}`}
                      href={'/entities/employees'}
                      tone="negative"
                      text={t('home.exceptions.missingProfile', { name: e.name })}
                    />
                  ))}
                  {home.exceptions.missingProfilesTotal > home.exceptions.missingProfiles.length && (
                    <ExceptionRow
                      href={'/entities/employees'}
                      tone="negative"
                      text={t('home.exceptions.moreMissingProfiles', {
                        count: home.exceptions.missingProfilesTotal - home.exceptions.missingProfiles.length,
                      })}
                    />
                  )}
                  {home.exceptions.missingWages.map((e) => (
                    <ExceptionRow
                      key={`w-${e.id}`}
                      href="/admin/setup/labor-costing"
                      tone="warning"
                      text={t('home.exceptions.missingWage', { name: e.name })}
                    />
                  ))}
                  {home.exceptions.missingWagesTotal > home.exceptions.missingWages.length && (
                    <ExceptionRow
                      href="/admin/setup/labor-costing"
                      tone="warning"
                      text={t('home.exceptions.moreMissingWages', {
                        count: home.exceptions.missingWagesTotal - home.exceptions.missingWages.length,
                      })}
                    />
                  )}
                </ul>
              )}
            </HomePanel>

            <div className="shrink-0">
              <h3 className="mb-2 px-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {t('home.directory.title')}
              </h3>
              <LiveDirectory items={directory} />
            </div>

            {canManage && (
              <div className="flex items-center gap-2 px-1 text-xs">
                <Link
                  href={'/admin/setup/payroll?tab=schedules' as never}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t('links.paySchedules')}
                </Link>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <Link
                  href={'/admin/setup/payroll?tab=components' as never}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t('links.payComponents')}
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </ListPageLayout>
  )
}

/* ------------------------------------------------------------------------- */

type T = Awaited<ReturnType<typeof getTranslations<'payroll'>>>

/** One schedule's current-period row: period facts + the smart action. */
function ScheduleCard({
  schedule,
  canRun,
  t,
  money,
}: {
  schedule: PayrollScheduleCard
  canRun: boolean
  t: T
  money: (v: string | number) => string
}) {
  const run = schedule.run
  const wizardHref = run
    ? `/payroll/runs/${run.documentId}?step=${run.runStatus === 'draft' ? 'period' : run.runStatus === 'calculated' ? 'review' : 'finish'}`
    : null
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {schedule.name}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {t(`home.frequency.${schedule.frequency}`)}
          </span>
          {run && <RunStatusBadge status={run.runStatus} />}
        </div>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
          <Fact label={t('columns.period')}>
            {shortDate(schedule.periodStart)} – {shortDate(schedule.periodEnd)}
          </Fact>
          <Fact label={t('columns.payDate')}>{shortDate(schedule.payDate)}</Fact>
          <Fact label={t('columns.employees')}>{schedule.activeEmployees.toLocaleString()}</Fact>
          {run && run.runStatus !== 'draft' ? (
            <Fact label={t('columns.net')}>{money(run.netTotal)}</Fact>
          ) : (
            <span aria-hidden />
          )}
        </dl>
      </div>
      <div className="shrink-0">
        {run && wizardHref ? (
          <Button variant={run.runStatus === 'committed' ? 'outline' : 'default'} size="sm" asChild>
            <Link href={wizardHref as never}>
              {run.runStatus === 'committed' ? t('home.actions.reviewPost') : t('home.actions.resume')}
              <ArrowRight size={14} aria-hidden />
            </Link>
          </Button>
        ) : canRun ? (
          <StartRunButton payScheduleId={schedule.id} />
        ) : null}
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
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

function ExceptionRow({
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

function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
