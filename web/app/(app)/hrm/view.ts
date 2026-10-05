import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
  field,
  grid,
  page,
  pageHeader,
  panel,
  ref,
  spanRow,
  statTile,
  table,
  text,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadHrmHome, type HrmHomeData } from '../../../lib/hrm/home'

/**
 * The HRM cockpit, split into a loader and a spec — the customers/banking
 * archetype: a vitals strip of three to five tiles, a hero column (a
 * waiting decision first, then the workforce pulse, trend and department
 * mix, then the module work queues), and a rail that is the work queue
 * (needs attention, the 30-day starts and ends, the live directory of every
 * HRM surface, quick actions). ViewSpec composes the grid and the panels;
 * panel bodies are shared blocks and widgets, and every figure arrives
 * loader-resolved through the canonical HRM reads. A single-entity org never
 * sees an employer line: the loader says whether the org runs more than
 * one, and the spec passes that fact to the department mix.
 */

const f = ref<HrmHomeData>()
const item = field

/** Vitals columns by tile count, so a strip of three or four never leaves a gap. */
const VITALS_GRID: Record<number, string> = {
  3: 'grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3',
  4: 'grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4',
  5: 'grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5',
}

export function hrmSpec(data: HrmHomeData): PageSpec {
  // Vitals: every figure someone acts on, the same strip every module home
  // carries. Counts of configuration (subsidiaries, departments) are not
  // vitals and do not sit here. Positions and leave join only with their
  // grants, so the strip runs three to five tiles wide.
  const vitals = [
    statTile({
      iconKey: 'users',
      accent: 'teal',
      label: f('headcountLabel'),
      value: f('headcountValue'),
      sub: f('headcountSub'),
    }),
    ...(data.positions
      ? [
          statTile({
            iconKey: 'briefcase',
            accent: 'indigo',
            label: f('positions.openPositionsLabel'),
            value: f('positions.openPositionsValue'),
            sub: f('positions.openPositionsSub'),
          }),
        ]
      : []),
    ...(data.onLeaveLabel
      ? [
          statTile({
            iconKey: 'timer',
            accent: 'sky',
            label: f('onLeaveLabel'),
            value: f('onLeaveValue'),
            sub: f('onLeaveSub'),
          }),
        ]
      : []),
    statTile({
      iconKey: 'clipboard-check',
      accent: data.pendingAccent,
      label: f('pendingLabel'),
      value: f('pendingValue'),
      sub: f('pendingSub'),
    }),
    statTile({
      iconKey: 'calendar-clock',
      accent: 'violet',
      label: f('startingLabel'),
      value: f('startingValue'),
      sub: f('startingSub'),
    }),
  ]

  return page({
    route: '/hrm',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('hrm-new-menu', {
            canCreateEmployee: data.canCreateEmployee,
            canProposeChange: data.canProposeChange,
            canCreateProcess: data.canCreateProcess,
            employeeLabel: data.newEmployee.label,
            changeLabel: data.actions.find((action) => action.href === '/hrm/change-requests')?.label ?? '',
            processLabel: data.newProcessLabel,
          }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        grid(VITALS_GRID[vitals.length] ?? VITALS_GRID[4], vitals),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          // The hero column: a decision waiting in the change-request queue
          // leads it; then the workforce itself (pulse, twelve-month trend,
          // department mix); then the module work queues side by side, the
          // evidence trail, and the headcount plan.
          grid('flex min-h-0 flex-col gap-5 overflow-y-auto lg:col-span-2', [
            panel({
              title: f('pendingTitle'),
              iconKey: 'clipboard-check',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              // A clear queue collapses like every other quiet module; the
              // pending tile and the attention list still report it, and a
              // refusal always renders.
              when: f('pendingHasActivity'),
              blocks: [
                widgetBlock('hrm-pending-requests', {
                  items: data.pending,
                  empty: data.pendingEmpty,
                  viewAllHref: data.pendingQueueHref,
                  viewAllLabel: data.pendingViewAll,
                  refusal: data.pendingRefusal,
                  notAvailable: data.queueNotAvailable,
                }),
              ],
            }),
            panel({
              title: f('workforceTitle'),
              iconKey: 'users',
              hint: f('trendHint'),
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('hrm-pulse', { figures: data.workforcePulse ?? [] }),
                grid('border-t border-slate-100 px-4 pt-4 pb-1 dark:border-slate-800', [
                  widgetBlock('trend-chart', {
                    labels: data.trendLabels,
                    series: [{ name: data.trendSeriesName, data: data.trendData, color: '#14b8a6' }],
                    height: 200,
                    area: true,
                    format: 'count',
                  }),
                ]),
                widgetBlock('hrm-headcount-mix', {
                  rows: data.groups,
                  showEmployer: data.multiSubsidiary,
                  title: data.mixTitle,
                  empty: data.groupsEmpty,
                  totalLabel: data.totalLabel,
                  totalValue: data.totalValue,
                }),
              ],
            }),
            // Subordinate modules pair up two to a row on wide screens; a
            // quiet module collapses (UX-14) while its grant still owns the
            // directory and tab entries, so nothing hides.
            grid('grid shrink-0 grid-cols-1 items-start gap-5 xl:grid-cols-2', [
              ...(data.onboarding
                ? [
                    panel({
                      title: data.onboarding.panelTitle,
                      iconKey: 'list-checks',
                      bodyClassName: 'p-0',
                      when: f('onboardingHasActivity'),
                      blocks: [
                        widgetBlock('hrm-onboarding-panel', {
                          openCount: data.onboarding.openCount,
                          overdue: data.onboarding.overdue,
                          upcoming: data.onboarding.upcoming,
                          openLabel: data.onboarding.openLabel,
                          overdueLabel: data.onboarding.overdueLabel,
                          upcomingLabel: data.onboarding.upcomingLabel,
                          empty: data.onboarding.empty,
                          noDueSoon: data.onboarding.noDueSoon,
                          viewAll: data.onboarding.viewAll,
                          viewAllHref: data.onboarding.viewAllHref,
                        }),
                      ],
                    }),
                  ]
                : []),
              ...(data.leavePanel
                ? [
                    panel({
                      title: data.leavePanel.title,
                      iconKey: 'timer',
                      bodyClassName: 'p-0',
                      when: f('leaveHasActivity'),
                      blocks: [
                        widgetBlock('hrm-leave-panel', {
                          items: data.leavePanel.onLeaveToday,
                          empty: data.leavePanel.onLeaveEmpty,
                          pendingCount: data.leavePanel.pendingCount,
                          pendingLabel: data.leavePanel.pendingLabel,
                          queueHref: data.leavePanel.queueHref,
                          viewAllLabel: data.pendingViewAll,
                        }),
                      ],
                    }),
                  ]
                : []),
              ...(data.benefitsPanel
                ? [
                    panel({
                      title: data.benefitsPanel.title,
                      iconKey: 'heart-pulse',
                      bodyClassName: 'p-0',
                      when: f('benefitsHasActivity'),
                      blocks: [
                        widgetBlock('hrm-benefits-panel', {
                          openWindows: data.benefitsPanel.openWindows,
                          openLabel: data.benefitsPanel.openLabel,
                          openEmpty: data.benefitsPanel.openEmpty,
                          pendingCount: data.benefitsPanel.pendingCount,
                          pendingLabel: data.benefitsPanel.pendingLabel,
                          missingCount: data.benefitsPanel.missingCount,
                          missingLabel: data.benefitsPanel.missingLabel,
                          queueHref: data.benefitsPanel.queueHref,
                          viewAllLabel: data.pendingViewAll,
                        }),
                      ],
                    }),
                  ]
                : []),
              ...(data.recruiting
                ? [
                    panel({
                      title: data.recruiting.panelTitle,
                      iconKey: 'target',
                      bodyClassName: 'p-0',
                      when: f('recruitingHasActivity'),
                      blocks: [
                        widgetBlock('hrm-recruiting-panel', {
                          figures: [
                            {
                              label: data.recruiting.openLabel,
                              value: data.recruiting.openValue,
                            },
                            {
                              label: data.recruiting.awaitingLabel,
                              value: data.recruiting.awaitingValue,
                            },
                            {
                              label: data.recruiting.interviewsLabel,
                              value: data.recruiting.interviewsValue,
                            },
                          ],
                          viewAll: data.recruiting.viewAll,
                          viewAllHref: data.recruiting.viewAllHref,
                        }),
                      ],
                    }),
                  ]
                : []),
            ]),
            panel({
              title: f('recentTitle'),
              iconKey: 'scroll-text',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('hrm-recent-changes', {
                  items: data.recent,
                  empty: data.recentEmpty,
                  notAvailable: data.queueNotAvailable,
                }),
              ],
            }),
            ...(data.positions
              ? [
                  panel({
                    title: f('positions.vacancyTitle'),
                    iconKey: 'briefcase',
                    className: 'shrink-0',
                    bodyClassName: 'p-0',
                    blocks: [
                      table({
                        variant: 'app',
                        rows: f('positions.groups'),
                        rowKey: item('id'),
                        empty: { title: f('positions.vacancyEmpty') },
                        trailing:
                          data.positions.groups.length > 0
                            ? [
                                spanRow({
                                  label: f('positions.totalLabel'),
                                  labelColSpan: data.multiSubsidiary ? 2 : 1,
                                  cells: [
                                    {
                                      cell: text(f('positions.totals.positions')),
                                      align: 'right',
                                      className: 'font-semibold tabular-nums',
                                    },
                                    {
                                      cell: text(f('positions.totals.plannedFte')),
                                      align: 'right',
                                      className: 'font-semibold tabular-nums',
                                    },
                                    {
                                      cell: text(f('positions.totals.fundedFte')),
                                      align: 'right',
                                      className: 'font-semibold tabular-nums',
                                    },
                                    {
                                      cell: text(f('positions.totals.filledFte')),
                                      align: 'right',
                                      className: 'font-semibold tabular-nums',
                                    },
                                    {
                                      cell: text(f('positions.totals.vacantFte')),
                                      align: 'right',
                                      className: 'font-semibold tabular-nums',
                                    },
                                  ],
                                }),
                              ]
                            : undefined,
                        columns: [
                          ...(data.multiSubsidiary ? [column(data.positions.employerColumn, text(item('employer')))] : []),
                          column(data.positions.departmentColumn, text(item('department'))),
                          column(data.positions.positionsColumn, text(item('positions')), { align: 'right', className: 'tabular-nums' }),
                          column(data.positions.plannedColumn, text(item('plannedFte')), { align: 'right', className: 'tabular-nums' }),
                          column(data.positions.fundedColumn, text(item('fundedFte')), { align: 'right', className: 'tabular-nums' }),
                          column(data.positions.filledColumn, text(item('filledFte')), { align: 'right', className: 'tabular-nums' }),
                          column(data.positions.vacantColumn, text(item('vacantFte')), { align: 'right', className: 'tabular-nums' }),
                        ],
                      }),
                    ],
                  }),
                ]
              : []),
          ]),

          // The rail: what needs doing, the 30-day starts and ends, the
          // workspace as a live directory, and the quick actions — the
          // customers and banking rail, in that order.
          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('attention-list', {
                  items: data.attention,
                  allClear: data.attentionAllClear,
                }),
              ],
            }),
            panel({
              title: f('upcomingTitle'),
              iconKey: 'calendar-clock',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('hrm-upcoming-changes', {
                  starts: data.starts,
                  ends: data.ends,
                  startsTitle: data.startsTitle,
                  startsEmpty: data.startsEmpty,
                  endsTitle: data.endsTitle,
                  endsEmpty: data.endsEmpty,
                  notAvailable: data.queueNotAvailable,
                  truncated: data.upcomingTruncated,
                  truncatedNote: data.upcomingTruncatedNote,
                }),
                textBlock(f('upcomingHint'), {
                  size: 'xs',
                  className: 'border-t border-slate-100 px-4 py-2.5 text-slate-400 dark:border-slate-800 dark:text-slate-500',
                }),
              ],
            }),
            widgetBlock('directory-section', {
              items: data.directory,
              title: data.directoryTitle,
            }),
            widgetBlock('directory-section', {
              items: data.actions,
              title: data.actionsTitle,
            }),
          ]),
        ]),
      ]),
    ],
  })
}

export async function loadHrmPage(): Promise<HrmHomeData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.employment.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadHrmHome(authz)
}

export async function hrmTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('home.title')
}
