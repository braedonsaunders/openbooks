import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
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
 * The headcount hero is a `stat-tile` vitals strip plus one
 * `hrm-headcount-table` widget over loader-resolved rows and strings — a
 * widget, not a slot, because there is no capability left to re-derive: the
 * loader already resolved headcount through the canonical HRM read service.
 * The rail carries the pending queue, the 30-day starts and ends, the
 * recent change evidence, the readiness panel, and the quick actions —
 * every empty section states what is empty and why, so zero never renders
 * as a blank cockpit.
 */

const f = ref<HrmHomeData>()

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
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          grid('flex min-h-0 flex-col gap-5 lg:col-span-2', [
            panel({
              title: f('groupsTitle'),
              iconKey: 'users',
              className: 'min-h-0',
              bodyClassName: 'p-0',
              blocks: [
                widgetBlock('hrm-headcount-table', {
                  groups: data.groups,
                  total: data.total,
                  employerColumn: data.employerColumn,
                  departmentColumn: data.departmentColumn,
                  headcountColumn: data.headcountColumn,
                  unassigned: data.unassigned,
                  empty: data.groupsEmpty,
                  totalLabel: data.totalLabel,
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
