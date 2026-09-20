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
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadHrmHome, type HrmHomeData } from '../../../lib/hrm/home'

/**
 * The HRM cockpit, split into a loader and a spec.
 *
 * This follows the purchasing-cockpit archetype, not a list page: ViewSpec
 * composes the grid and the panels; the panel BODIES stay components, shared
 * by the page and the widget registry via ./sections so they cannot drift
 * (see ../../purchasing/view.ts for the division and its rationale).
 *
 * The headcount hero is a `stat-tile` vitals strip plus a `table` block
 * over loader-resolved rows and strings — a block, not a widget, because
 * there is no capability left to re-derive: the loader already resolved
 * headcount through the canonical HRM read service. The rail carries the pending queue, the 30-day starts and ends, the
 * recent change evidence, the readiness panel, and the quick actions —
 * every empty section states what is empty and why, so zero never renders
 * as a blank cockpit.
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
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4', [
          statTile({
            iconKey: 'users',
            accent: 'teal',
            label: f('headcountLabel'),
            value: f('headcountValue'),
            sub: f('headcountSub'),
          }),
          statTile({
            iconKey: 'building',
            accent: 'indigo',
            label: f('employersLabel'),
            value: f('employersValue'),
            sub: f('employersSub'),
          }),
          statTile({
            iconKey: 'layers',
            accent: 'violet',
            label: f('departmentsLabel'),
            value: f('departmentsValue'),
            sub: f('departmentsSub'),
          }),
          statTile({
            iconKey: 'clipboard-check',
            accent: 'amber',
            label: f('pendingLabel'),
            value: f('pendingValue'),
            sub: f('pendingSub'),
          }),
          ...(data.positions
            ? [
                statTile({
                  iconKey: 'briefcase',
                  accent: 'amber',
                  label: f('positions.openPositionsLabel'),
                  value: f('positions.openPositionsValue'),
                  sub: f('positions.openPositionsSub'),
                }),
                statTile({
                  iconKey: 'triangle-alert',
                  accent: 'red',
                  label: f('positions.unfundedFteLabel'),
                  value: f('positions.unfundedFteValue'),
                  sub: f('positions.unfundedFteSub'),
                }),
              ]
            : []),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          grid('flex min-h-0 flex-col gap-5 lg:col-span-2', [
            panel({
              title: f('groupsTitle'),
              iconKey: 'users',
              className: 'min-h-0',
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
                            labelColSpan: 2,
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
                    column(data.employerColumn, text(item('subsidiary'))),
                    // No href today, so the link degrades to text; the day
                    // the loader resolves a drill-through it renders a link.
                    column(data.departmentColumn, link(item('departmentLabel'), item('href'))),
                    column(data.headcountColumn, text(item('headcountLabel')), {
                      align: 'right',
                      className: 'tabular-nums',
                    }),
                  ],
                }),
              ],
            }),
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
            ...(data.leavePanel
              ? [
                  panel({
                    title: data.leavePanel.title,
                    iconKey: 'calendar',
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
          ]),

          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('upcomingTitle'),
              iconKey: 'timer',
              hint: f('upcomingHint'),
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
              ],
            }),
            panel({
              title: f('readinessTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('hrm-readiness', {
                  message: data.readinessMessage,
                  docHref: data.readinessDocHref,
                  docLabel: data.readinessDocLabel,
                  tone: data.readinessTone,
                }),
              ],
            }),
            widgetBlock('directory-section', {
              items: data.actions,
              title: data.actionsTitle,
            }),
            // The shared `directory-section` component (purchasing/sections.tsx)
            // renders the wrapper-or-null pair, so it is reused, not copied.
            widgetBlock('directory-section', {
              items: data.directory,
              title: data.directoryTitle,
            }),
            // The onboarding panel is additive: it renders exactly when the
            // loader resolved it (the viewer holds hrm.process.read).
            ...(data.onboarding
              ? [
                  panel({
                    title: data.onboarding.panelTitle,
                    iconKey: 'clipboard-check',
                    bodyClassName: 'p-0',
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
          ]),
        ]),

        ...(data.positions
          ? [
              panel({
                title: f('positions.vacancyTitle'),
                iconKey: 'briefcase',
                className: 'min-h-0',
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
                              labelColSpan: 2,
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
                      column(data.positions.employerColumn, text(item('employer'))),
                      column(data.positions.departmentColumn, text(item('department'))),
                      column(data.positions.positionsColumn, text(item('positions')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(data.positions.plannedColumn, text(item('plannedFte')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(data.positions.fundedColumn, text(item('fundedFte')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(data.positions.filledColumn, text(item('filledFte')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(data.positions.vacantColumn, text(item('vacantFte')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                    ],
                  }),
                ],
              }),
            ]
          : []),
        ]
      ),
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
