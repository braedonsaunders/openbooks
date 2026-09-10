import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { payrollHome } from '../../../lib/module-home/payroll'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPayroll, payrollSpec, scheduleCardProps } from './view'
import {
  ExceptionRow,
  PayrollChecklistBanner,
  PayrollManageLinks,
  PayrollPreviousRun,
  PayrollScheduleList,
  shortDate,
} from './sections'

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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadPayroll(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={payrollSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const canManage = can(authz, 'payroll.manage')
  const t = await getTranslations('payroll')
  const { money, moneyCompact } = await getMoneyFormatter()
  void (await searchParams)

  const home = await payrollHome(orgId, authz.allowedSubsidiaryIds)
  const tabs = await groupTabs('payroll', '/payroll', { orgId })

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
            href: '/payroll/opening-balances',
            label: t.has('home.directory.openingBalances' as never)
              ? t('home.directory.openingBalances' as never)
              : 'Opening balances',
            iconKey: 'history',
          },
          // Adoption's other half: opening balances carry the year in, a
          // parallel run proves the period. Both are migration surfaces, so
          // they sit next to each other.
          {
            href: '/payroll/parallel-run',
            label: t.has('home.directory.parallelRun' as never)
              ? t('home.directory.parallelRun' as never)
              : 'Parallel run',
            iconKey: 'clipboard-check',
          },
          // Retro pay belongs beside the runs, not with the migration
          // surfaces: it is an ordinary (if uncommon) payroll operation on
          // periods this system itself has already paid.
          {
            href: '/payroll/retro',
            label: t.has('home.directory.retro' as never)
              ? t('home.directory.retro' as never)
              : 'Retroactive pay',
            iconKey: 'history',
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
          <PayrollChecklistBanner
            text={t('checklist.incomplete', { count: home.missingSettings.length })}
            settings={home.missingSettings.map((key) => t(`settingsPage.fields.${key}`)).join(', ')}
            openSettingsLabel={t('checklist.openSettings')}
          />
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
              <PayrollScheduleList
                schedules={home.schedules.map((schedule) => scheduleCardProps(schedule, canRun, t, money))}
                emptyText={t('home.current.noSchedules')}
                showSetupLink={canManage}
                setupLabel={t('links.paySchedules')}
                labels={{
                  frequency: Object.fromEntries(
                    home.schedules.map((s) => [s.id, t(`home.frequency.${s.frequency}`)]),
                  ),
                  period: t('columns.period'),
                  payDate: t('columns.payDate'),
                  employees: t('columns.employees'),
                  net: t('columns.net'),
                }}
              />
            </HomePanel>

            <HomePanel title={t('home.previous.title')} icon="check-circle" className="shrink-0">
              <PayrollPreviousRun
                run={
                  home.previousRun
                    ? {
                        periodStart: shortDate(home.previousRun.periodStart),
                        periodEnd: shortDate(home.previousRun.periodEnd),
                        payDate: shortDate(home.previousRun.payDate),
                        net: money(home.previousRun.netTotal),
                        employees: home.previousRun.employeeCount.toLocaleString(),
                        posted: home.previousRun.posted,
                        badgeLabel: t(home.previousRun.posted ? 'status.posted' : 'status.committed'),
                        href: `/payroll/runs/${home.previousRun.documentId}`,
                        documentNumber: home.previousRun.documentNumber,
                      }
                    : null
                }
                periodLabel={t('columns.period')}
                payDateLabel={t('columns.payDate')}
                netLabel={t('columns.net')}
                employeesLabel={t('columns.employees')}
                noneText={t('home.previous.none')}
              />
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
              <PayrollManageLinks
                paySchedulesLabel={t('links.paySchedules')}
                payComponentsLabel={t('links.payComponents')}
              />
            )}
          </div>
        </div>
      </div>
    </ListPageLayout>
  )
}

/* ------------------------------------------------------------------------- */

/** Moved to ./sections so both render paths share one short-date formatter. */
