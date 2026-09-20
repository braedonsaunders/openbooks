import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  column,
  field,
  grid,
  link,
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
import { isFeatureEnabled } from '../../../lib/features'
import { loadHrmHome, type HrmHomeData } from '../../../lib/hrm/home'

/**
 * The HRM cockpit, split into a loader and a spec — the banking/purchasing
 * archetype: a four-tile vitals strip, a hero column (the 12-month headcount
 * trend and headcount by department, then the queues that feed them), and a
 * rail that is the work queue (needs attention, the live directory, the
 * 30-day starts and ends, quick actions). ViewSpec composes the grid and
 * the panels; panel bodies are shared blocks and widgets, and every figure
 * arrives loader-resolved through the canonical HRM reads. A single-entity
 * org never sees a subsidiary column: the loader says whether the org runs
 * more than one, and the spec builds the columns from that fact.
 */

const f = ref<HrmHomeData>()
const item = field

export function hrmSpec(data: HrmHomeData): PageSpec {
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
          widget(
            'new-role-party',
            { basePath: data.newEmployee.basePath, role: data.newEmployee.role, label: data.newEmployee.label },
            f('canCreateEmployee'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Vitals: four tiles, the same strip every module home carries.
        // Each is a figure someone acts on; counts of configuration
        // (subsidiaries, departments) are not vitals and do not sit here.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4', [
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
            : data.onLeaveLabel
              ? [
                  statTile({
                    iconKey: 'timer',
                    accent: 'indigo',
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
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          // The hero column: the trend and the headcount table are the
          // headline objects; the queues that feed them sit below.
          grid('flex min-h-0 flex-col gap-5 overflow-y-auto lg:col-span-2', [
            panel({
              title: f('trendTitle'),
              iconKey: 'trending-up',
              hint: f('trendHint'),
              className: 'shrink-0',
              blocks: [
                widgetBlock('trend-chart', {
                  labels: data.trendLabels,
                  series: [{ name: data.trendSeriesName, data: data.trendData }],
                  height: 170,
                  area: true,
                  format: 'count',
                }),
              ],
            }),
            panel({
              title: f('groupsTitle'),
              iconKey: 'users',
              className: 'shrink-0',
              bodyClassName: 'p-0',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('groups'),
                  rowKey: item('id'),
                  empty: { title: f('groupsEmpty') },
                  // Totals only beside rows: with no groups the `empty`
                  // state renders instead. A present-but-empty `trailing`
                  // array would suppress the empty state, so this is
                  // undefined.
                  trailing:
                    data.groups.length > 0
                      ? [
                          spanRow({
                            label: f('totalLabel'),
                            labelColSpan: data.multiSubsidiary ? 2 : 1,
                            cells: [
                              {
                                cell: text(f('totalValue')),
                                align: 'right',
                                className: 'font-semibold tabular-nums',
                              },
                            ],
                          }),
                        ]
                      : undefined,
                  columns: [
                    // The subsidiary column exists only for an org that runs
                    // more than one: a single-entity org sees departments.
                    ...(data.multiSubsidiary ? [column(data.employerColumn, text(item('subsidiary')))] : []),
                    column(data.departmentColumn, link(item('departmentLabel'), item('href'))),
                    column(data.headcountColumn, text(item('headcountLabel')), {
                      align: 'right',
                      className: 'tabular-nums',
                    }),
                  ],
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
                                    { cell: text(f('positions.totals.positions')), align: 'right', className: 'font-semibold tabular-nums' },
                                    { cell: text(f('positions.totals.plannedFte')), align: 'right', className: 'font-semibold tabular-nums' },
                                    { cell: text(f('positions.totals.fundedFte')), align: 'right', className: 'font-semibold tabular-nums' },
                                    { cell: text(f('positions.totals.filledFte')), align: 'right', className: 'font-semibold tabular-nums' },
                                    { cell: text(f('positions.totals.vacantFte')), align: 'right', className: 'font-semibold tabular-nums' },
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
            panel({
              title: f('pendingTitle'),
              iconKey: 'clipboard-check',
              bodyClassName: 'p-0',
              className: 'shrink-0',
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
            ...(data.onboarding
              ? [
                  panel({
                    title: data.onboarding.panelTitle,
                    iconKey: 'list-checks',
                    bodyClassName: 'p-0',
                    className: 'shrink-0',
                    blocks: [
                      widgetBlock('hrm-onboarding-panel', {
                        openCount: data.onboarding.openCount,
                        overdue: data.onboarding.overdue,
                        upcoming: data.onboarding.upcoming,
                        openLabel: data.onboarding.openLabel,
                        overdueLabel: data.onboarding.overdueLabel,
                        upcomingLabel: data.onboarding.upcomingLabel,
                        empty: data.onboarding.empty,
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
                    className: 'shrink-0',
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
            ...(data.recruiting
              ? [
                  panel({
                    title: data.recruiting.panelTitle,
                    iconKey: 'briefcase',
                    bodyClassName: 'p-0',
                    className: 'shrink-0',
                    blocks: [
                      widgetBlock('hrm-recruiting-panel', {
                        figures: [
                          { label: data.recruiting.openLabel, value: data.recruiting.openValue },
                          { label: data.recruiting.awaitingLabel, value: data.recruiting.awaitingValue },
                          { label: data.recruiting.interviewsLabel, value: data.recruiting.interviewsValue },
                        ],
                        viewAll: data.recruiting.viewAll,
                        viewAllHref: data.recruiting.viewAllHref,
                      }),
                    ],
                  }),
                ]
              : []),
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
          ]),

          // The rail: what needs doing, the workspace as a live directory,
          // the 30-day starts and ends, and the quick actions — the banking
          // and purchasing rail, in that order.
          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [widgetBlock('attention-list', { items: data.attention, allClear: data.attentionAllClear })],
            }),
            widgetBlock('directory-section', {
              items: data.directory,
              title: data.directoryTitle,
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
                textBlock(f('upcomingHint'), { size: 'xs', className: 'border-t border-slate-100 px-4 py-2.5 text-slate-400 dark:border-slate-800 dark:text-slate-500' }),
              ],
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
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadHrmHome(authz)
}

export async function hrmTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('home.title')
}
