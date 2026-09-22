import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  grid,
  link,
  page,
  pageHeader,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadBenefits, type BenefitsData } from '../../../../lib/hrm/benefits'

/**
 * The Benefits tab, split into a loader and a spec.
 *
 * Windows render through the shared `table` block (variant 'app') over
 * loader-resolved rows. Windows and Enrolments are the two VIEWS, on the
 * shared subtab strip; the window-status filter rides the shared
 * `list-toolbar` beside it. The page's primary action is the
 * shared 'link-button' widget ("New window") FIRST in the page header,
 * then the module-home-tabs strip. The window drawer (progress plus its
 * enrolments) and the new-window dialog open from URL search params
 * through small client islands; pending rows carry the approve island in
 * the row-action cell. Forms use @openbooks/ui primitives, never bespoke
 * buttons or hand-rolled tables.
 */

const f = ref<BenefitsData>()

// The registry builds every spec from its data alone, so the base path
// defaults to the literal route the spec declares.
export function benefitsSpec(data: BenefitsData, basePath: string = '/hrm/benefits'): PageSpec {
  return page({
    route: '/hrm/benefits',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('newWindowHref'), label: f('newWindowButton'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // A computed refusal (unknown segment) renders with its message
      // intact — never a success, never an empty table.
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      {
        ...grid('flex h-full min-h-0 flex-col gap-4', [
          // The view switch and the window-status filter on one row. The
          // filter used to sit INSIDE the list card, above the rows, and it
          // carried the view switch as one of its options: picking
          // "Enrolments" swapped the table for a different entity.
          grid('flex shrink-0 flex-wrap items-center gap-3', [
            widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
            ...(data.showingEnrolments
              ? []
              : [
                  widgetBlock('list-toolbar', {
                    basePath,
                    currentParams: data.currentParams,
                    filters: [
                      {
                        paramKey: 'segment',
                        label: data.segmentsLabel,
                        allLabel: data.allLabel,
                        options: data.segments,
                      },
                    ],
                  }),
                ]),
          ]),
            ...(data.showingEnrolments
              ? [
                  table({
                    variant: 'app',
                    rows: f('enrollmentRows'),
                    rowKey: item('id'),
                    columns: [
                      column(f('enrollmentColumns.employee'), link(item('employeeLabel'), item('employeeHref'))),
                      column(f('enrollmentColumns.plan'), text(item('planCode'))),
                      column(f('enrollmentColumns.coverage'), text(item('coverageLabel'))),
                      column(f('enrollmentColumns.employeeAmount'), text(item('employeeAmountPerPeriod')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(f('enrollmentColumns.employerAmount'), text(item('employerAmountPerPeriod')), {
                        align: 'right',
                        className: 'tabular-nums',
                      }),
                      column(f('enrollmentColumns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                      column(
                        '',
                        widgetCell('hrm-enrollment-actions', {
                          enrollmentId: item('id'),
                          enrollmentStatus: item('status'),
                          approveLabel: f('approveLabel'),
                          canManage: f('canManage'),
                        }),
                      ),
                    ],
                    empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                  }),
                ]
              : [
                  table({
                    variant: 'app',
                    rows: f('windowRows'),
                    rowKey: item('id'),
                    columns: [
                      column(f('columns.window'), link(item('name'), item('windowHref'))),
                      column(f('columns.kind'), text(item('kindLabel'))),
                      column(f('columns.range'), text(item('rangeLabel'), { className: 'tabular-nums' })),
                      column(f('columns.elections'), text(item('elections')), { align: 'right', className: 'tabular-nums' }),
                      column(f('columns.pending'), text(item('pendingApprovals')), { align: 'right', className: 'tabular-nums' }),
                      column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                      column('', link(item('openLabel'), item('windowHref'))),
                    ],
                    empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                  }),
                ]),
            widgetBlock(
              'hrm-window-dialog',
              {
                closeHref: f('dialogCloseHref'),
                subsidiaryOptions: data.subsidiaryOptions,
                departmentOptions: data.departmentOptions,
              },
              f('dialogOpen'),
            ),
            widgetBlock(
              'hrm-window-drawer',
              { drawer: data.drawer, closeHref: f('drawerCloseHref') },
              f('drawer'),
            ),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadBenefitsPage(sp: Record<string, string | undefined>): Promise<BenefitsData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.benefits.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadBenefits(authz, sp)
}

export async function benefitsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('benefits.title')
}
