import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import {
  payrollHome,
  type PayrollScheduleCard,
  type PreviousRun,
} from '../../../lib/module-home/payroll'
import {
  shortDate,
  type PayrollChecklistBannerProps,
  type PayrollManageLinksProps,
  type PayrollPreviousRunProps,
  type PayrollScheduleListProps,
} from './sections'

/**
 * The payroll cockpit, split into a loader and a spec.
 *
 * This page follows the purchasing-cockpit archetype: ViewSpec composes the
 * GRID and the PANELS; the panel bodies stay components, shared by both
 * render paths via ./sections so they cannot drift. The schedule cards carry
 * the one smart action (Start / Resume / Review), the previous-period panel
 * carries a conditional badge + link, and the checklist banner carries a
 * translated settings list — all of those are conditional pairs, which are
 * components, not spec constructs.
 *
 * Everything below the spec is loader work copied verbatim from page.tsx: the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * `payroll.run` / `payroll.manage` capability flags, the module tabs, the
 * directory (including its visibility-filtered badges — a count is a
 * disclosure), and every formatted value (money via getMoneyFormatter,
 * short dates, toLocaleString counts).
 */

export interface PayrollData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof groupTabs>>
  canRun: boolean
  canManage: boolean
  showChecklist: boolean
  checklist: PayrollChecklistBannerProps
  employeesLabel: string
  employeesValue: string
  employeesSub: string
  periodsLabel: string
  periodsValue: string
  periodsSub: string
  ytdGrossLabel: string
  ytdGrossValue: string
  ytdGrossSub: string
  ytdNetLabel: string
  ytdNetValue: string
  ytdNetSub: string
  nextPayLabel: string
  nextPayValue: string
  nextPaySub: string | null
  currentTitle: string
  scheduleList: PayrollScheduleListProps
  previousTitle: string
  previousRun: PayrollPreviousRunProps
  exceptionsTitle: string
  exceptionHint: string | null
  exceptionItems: { href: string; tone: 'negative' | 'warning'; text: string }[]
  exceptionsAllClear: string
  directoryTitle: string
  directory: DirectoryItem[]
  manageLinks: PayrollManageLinksProps
}

export async function loadPayroll(
  sp: Record<string, string | undefined>,
): Promise<PayrollData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const canManage = can(authz, 'payroll.manage')
  const t = await getTranslations('payroll')
  const { money, moneyCompact } = await getMoneyFormatter()
  void sp

  const home = await payrollHome(orgId, authz.allowedSubsidiaryIds)
  const tabs = await groupTabs('payroll', '/payroll', { orgId })

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

  const schedules: PayrollScheduleListProps['schedules'] = home.schedules.map((schedule) =>
    scheduleCardProps(schedule, canRun, t, money),
  )

  const previousRun: PreviousRun | null = home.previousRun

  return {
    title: t('title'),
    description: t('description'),
    tabs,
    canRun,
    canManage,
    showChecklist: canManage && home.missingSettings.length > 0,
    checklist: {
      text: t('checklist.incomplete', { count: home.missingSettings.length }),
      settings: home.missingSettings.map((key) => t(`settingsPage.fields.${key}`)).join(', '),
      openSettingsLabel: t('checklist.openSettings'),
    },
    employeesLabel: t('home.vitals.employees'),
    employeesValue: home.activeEmployees.toLocaleString(),
    employeesSub: t('home.vitals.employeesSub'),
    periodsLabel: t('home.vitals.periodsRan', { year: home.taxYear }),
    periodsValue: home.defaultPeriodsPerYear
      ? t('home.vitals.periodsOf', { ran: home.runsThisYear, total: home.defaultPeriodsPerYear })
      : home.runsThisYear.toLocaleString(),
    periodsSub: t('home.vitals.periodsRanSub'),
    ytdGrossLabel: t('home.vitals.ytdGross'),
    ytdGrossValue: moneyCompact(home.ytdGross),
    ytdGrossSub: t('home.vitals.ytdEmployerCost', { amount: moneyCompact(home.ytdEmployerCost) }),
    ytdNetLabel: t('home.vitals.ytdNet'),
    ytdNetValue: moneyCompact(home.ytdNet),
    ytdNetSub: t('home.vitals.ytdNetSub'),
    nextPayLabel: t('home.vitals.nextPayDate'),
    nextPayValue: home.nextPayDate ? shortDate(home.nextPayDate) : '—',
    nextPaySub: home.nextPayDate ? null : t('home.vitals.noSchedule'),
    currentTitle: t('home.current.title'),
    scheduleList: {
      schedules,
      emptyText: t('home.current.noSchedules'),
      showSetupLink: canManage,
      setupLabel: t('links.paySchedules'),
      labels: {
        frequency: Object.fromEntries(
          home.schedules.map((s) => [s.id, t(`home.frequency.${s.frequency}`)]),
        ),
        period: t('columns.period'),
        payDate: t('columns.payDate'),
        employees: t('columns.employees'),
        net: t('columns.net'),
      },
    },
    previousTitle: t('home.previous.title'),
    previousRun: {
      run: previousRun
        ? {
            periodStart: shortDate(previousRun.periodStart),
            periodEnd: shortDate(previousRun.periodEnd),
            payDate: shortDate(previousRun.payDate),
            net: money(previousRun.netTotal),
            employees: previousRun.employeeCount.toLocaleString(),
            posted: previousRun.posted,
            badgeLabel: t(previousRun.posted ? 'status.posted' : 'status.committed'),
            href: `/payroll/runs/${previousRun.documentId}`,
            documentNumber: previousRun.documentNumber,
          }
        : null,
      periodLabel: t('columns.period'),
      payDateLabel: t('columns.payDate'),
      netLabel: t('columns.net'),
      employeesLabel: t('columns.employees'),
      noneText: t('home.previous.none'),
    },
    exceptionsTitle: t('home.exceptions.title'),
    exceptionHint: exceptionCount > 0 ? String(exceptionCount) : null,
    exceptionItems: [
      ...home.exceptions.missingProfiles.map((e) => ({
        href: '/entities/employees',
        tone: 'negative' as const,
        text: t('home.exceptions.missingProfile', { name: e.name }),
      })),
      ...(home.exceptions.missingProfilesTotal > home.exceptions.missingProfiles.length
        ? [
            {
              href: '/entities/employees',
              tone: 'negative' as const,
              text: t('home.exceptions.moreMissingProfiles', {
                count:
                  home.exceptions.missingProfilesTotal - home.exceptions.missingProfiles.length,
              }),
            },
          ]
        : []),
      ...home.exceptions.missingWages.map((e) => ({
        href: '/admin/setup/labor-costing',
        tone: 'warning' as const,
        text: t('home.exceptions.missingWage', { name: e.name }),
      })),
      ...(home.exceptions.missingWagesTotal > home.exceptions.missingWages.length
        ? [
            {
              href: '/admin/setup/labor-costing',
              tone: 'warning' as const,
              text: t('home.exceptions.moreMissingWages', {
                count: home.exceptions.missingWagesTotal - home.exceptions.missingWages.length,
              }),
            },
          ]
        : []),
    ],
    exceptionsAllClear: t('home.exceptions.allClear'),
    directoryTitle: t('home.directory.title'),
    directory,
    manageLinks: {
      paySchedulesLabel: t('links.paySchedules'),
      payComponentsLabel: t('links.payComponents'),
    },
  }
}

type T = Awaited<ReturnType<typeof getTranslations<'payroll'>>>

/**
 * One schedule's current-period row: period facts + the smart action,
 * presentation-ready. The wizard href, the Resume/Review label and the Button
 * variant are derived here — a link when an open run exists, the Start button
 * when it may be started, nothing otherwise is a three-way choice a spec
 * cannot make, so the section component takes this resolved shape.
 */
export function scheduleCardProps(
  schedule: PayrollScheduleCard,
  canRun: boolean,
  t: T,
  money: (v: string | number) => string,
): PayrollScheduleListProps['schedules'][number] {
  const run = schedule.run
  const wizardHref = run
    ? `/payroll/runs/${run.documentId}?step=${run.runStatus === 'draft' ? 'period' : run.runStatus === 'calculated' ? 'review' : 'finish'}`
    : null
  return {
    id: schedule.id,
    name: schedule.name,
    frequency: schedule.frequency,
    periodStart: shortDate(schedule.periodStart),
    periodEnd: shortDate(schedule.periodEnd),
    payDate: shortDate(schedule.payDate),
    employees: schedule.activeEmployees.toLocaleString(),
    runStatus: run?.runStatus ?? null,
    net: run && run.runStatus !== 'draft' ? money(run.netTotal) : null,
    action:
      run && wizardHref
        ? {
            kind: 'resume' as const,
            href: wizardHref,
            outline: run.runStatus === 'committed',
            label: run.runStatus === 'committed' ? t('home.actions.reviewPost') : t('home.actions.resume'),
          }
        : canRun
          ? { kind: 'start' as const, scheduleId: schedule.id }
          : null,
  }
}

const f = ref<PayrollData>()

export function payrollSpec(data: PayrollData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex flex-col gap-4', [
        // The setup checklist: a presence-gated banner whose translated
        // settings list arrives pre-joined from the loader.
        {
          ...widgetBlock('payroll-settings-banner', {
            text: data.checklist.text,
            settings: data.checklist.settings,
            openSettingsLabel: data.checklist.openSettingsLabel,
          }),
          when: f('showChecklist'),
        },
        // Vitals. Five tiles, always rendered — only the next-pay-date tile
        // has a conditional sub, and the renderer omits it when empty.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({
            iconKey: 'users',
            accent: 'indigo',
            label: f('employeesLabel'),
            value: f('employeesValue'),
            sub: f('employeesSub'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'teal',
            label: f('periodsLabel'),
            value: f('periodsValue'),
            sub: f('periodsSub'),
          }),
          statTile({
            iconKey: 'badge-dollar',
            accent: 'violet',
            label: f('ytdGrossLabel'),
            value: f('ytdGrossValue'),
            sub: f('ytdGrossSub'),
          }),
          statTile({
            iconKey: 'wallet',
            accent: 'emerald',
            label: f('ytdNetLabel'),
            value: f('ytdNetValue'),
            sub: f('ytdNetSub'),
          }),
          statTile({
            iconKey: 'calendar-clock',
            accent: 'amber',
            label: f('nextPayLabel'),
            value: f('nextPayValue'),
            sub: f('nextPaySub'),
          }),
        ]),
        // Current periods hero + supporting rail.
        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          grid('flex min-h-0 flex-col gap-5 lg:col-span-2', [
            panel({
              title: f('currentTitle'),
              iconKey: 'calendar-clock',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                // The empty state lives inside the section component, not as
                // a negated conditional pair of blocks — see ./sections.
                widgetBlock('payroll-current-period', {
                  schedules: data.scheduleList.schedules,
                  emptyText: data.scheduleList.emptyText,
                  showSetupLink: data.scheduleList.showSetupLink,
                  setupLabel: data.scheduleList.setupLabel,
                  labels: data.scheduleList.labels,
                }),
              ],
            }),
            panel({
              title: f('previousTitle'),
              iconKey: 'check-circle',
              className: 'shrink-0',
              blocks: [
                widgetBlock('payroll-previous-run', {
                  run: data.previousRun.run,
                  periodLabel: data.previousRun.periodLabel,
                  payDateLabel: data.previousRun.payDateLabel,
                  netLabel: data.previousRun.netLabel,
                  employeesLabel: data.previousRun.employeesLabel,
                  noneText: data.previousRun.noneText,
                }),
              ],
            }),
          ]),
          grid('flex min-h-0 flex-col gap-5', [
            panel({
              title: f('exceptionsTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              hint: f('exceptionHint'),
              blocks: [
                // The all-clear state lives inside the registry's
                // attention-list, same as the purchasing cockpit.
                widgetBlock('attention-list', {
                  items: data.exceptionItems,
                  allClear: data.exceptionsAllClear,
                }),
              ],
            }),
            widgetBlock('directory-section', {
              items: data.directory,
              title: data.directoryTitle,
            }),
            {
              ...widgetBlock('payroll-manage-links', {
                paySchedulesLabel: data.manageLinks.paySchedulesLabel,
                payComponentsLabel: data.manageLinks.payComponentsLabel,
              }),
              when: f('canManage'),
            },
          ]),
        ]),
      ]),
    ],
  })
}
