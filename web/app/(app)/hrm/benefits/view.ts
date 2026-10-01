import 'server-only'
import { registeredListTable } from '../../../../lib/list/prepared-spec'

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
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadBenefits, type BenefitsData } from '../../../../lib/hrm/benefits'
import { benefitsOverviewBlocks } from './overview'

/**
 * Benefits uses the Customers module-home composition: native vitals, a
 * registered programs list in the two-column hero, and a scrolling rail
 * with attention, currency-separated award totals, destinations and reports.
 * Enrollment windows and employee elections stay on their focused views.
 * Builders and record drawers retain their existing URL-driven controls.
 */

const f = ref<BenefitsData>()

// The registry builds every spec from its data alone, so the base path
// defaults to the literal route the spec declares.
export function benefitsSpec(data: BenefitsData, basePath: string = '/hrm/benefits'): PageSpec {
  const showingOverview = data.portfolioView === 'overview'
  const showingWindows = data.portfolioView === 'windows'
  const showingPrograms = data.portfolioView === 'programs'
  const showingRewards = data.portfolioView === 'rewards'
  const showingIncentives = data.portfolioView === 'incentives'
  const showingPayouts = data.portfolioView === 'payouts'
  const awardRows =
    showingRewards ? data.rewardAwardRows : showingIncentives ? data.incentiveAwardRows : data.awardRows
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
          widget('link-button', {
            href: showingWindows ? f('newWindowHref') : showingRewards || showingPayouts ? f('newAwardHref') : f('newProgramHref'),
            label: showingWindows ? f('newWindowButton') : showingRewards || showingPayouts ? f('newAwardButton') : f('newProgramButton'),
            iconKey: 'plus',
          }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // A computed refusal (unknown segment) renders with its message
      // intact — never a success, never an empty table.
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      {
        ...grid(showingOverview ? 'flex h-full min-h-0 flex-col gap-4' : 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4', [
          ...(showingOverview ? benefitsOverviewBlocks(data) : []),
          widgetBlock(
            'empty-state',
            { title: data.vitalsRefusal?.title ?? '', description: data.vitalsRefusal?.message },
            f('vitalsRefusal'),
          ),
          // A refused programs read renders with its message intact beside
          // the sections it blocks — never a success around missing rows.
          ...(showingOverview ? [] : [widgetBlock(
            'empty-state',
            { title: data.programsRefusal?.title ?? '', description: data.programsRefusal?.message },
            f('programsRefusal'),
          )]),
          ...(showingOverview ? [] : [widgetBlock(
            'empty-state',
            { title: data.awardsRefusal?.title ?? '', description: data.awardsRefusal?.message },
            f('awardsRefusal'),
          )]),
          // A refused selector lookup renders beside the builders — an empty
          // picker never pretends its catalog is empty.
          widgetBlock(
            'empty-state',
            { title: data.optionsRefusal?.title ?? '', description: data.optionsRefusal?.message },
            f('optionsRefusal'),
          ),
          ...((showingPrograms || showingIncentives) && !data.programsRefusal
            ? [
                widgetBlock('hrm-program-table', {
                  rows: showingIncentives ? data.incentiveProgramRows : data.programRows,
                  text: data.programTableText,
                  total: (showingIncentives ? data.incentiveProgramRows : data.programRows).length,
                  truncated: false,
                }),
              ]
            : []),
          ...((showingRewards || showingIncentives || showingPayouts) && !data.awardsRefusal
            ? [
                ...(showingIncentives ? [grid('flex shrink-0 items-center gap-2', [
                  widgetBlock('link-button', { href: f('newAwardHref'), label: f('newAwardButton'), iconKey: 'plus' }, f('canManage')),
                ])] : []),
                widgetBlock('hrm-award-table', {
                  rows: awardRows,
                  text: data.awardTableText,
                  total: awardRows.length,
                  truncated: data.awardsTruncated,
                }),
              ]
            : []),
          ...(showingWindows
            ? [
                registeredListTable('hrm_benefits_windows', {
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
                }, [widget('list-toolbar', { basePath, currentParams: data.currentParams, filters: [{ paramKey: 'segment', label: data.segmentsLabel, allLabel: data.allLabel, options: data.segments }] })]),
              ]
            : []),
          ...(data.showingEnrolments
            ? [
                grid('flex shrink-0 items-center gap-2', [
                  widgetBlock('link-button', { href: `${basePath}?view=windows`, label: data.enrollmentWindowsButton }),
                ]),
                registeredListTable('hrm_benefits_enrolments', {
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
                        failedLabel: f('actionFailed'),
                        canManage: f('canManage'),
                      }),
                    ),
                  ],
                  empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                }),
              ]
            : []),
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
            { drawer: data.drawer, closeHref: f('drawerCloseHref'), canManage: f('canManage') },
            f('drawer'),
          ),
          widgetBlock(
            'hrm-program-builder',
            {
              closeHref: f('dialogCloseHref'),
              initialFamily: f('programBuilderFamily'),
              familyLocked: f('programBuilderLocked'),
              subsidiaryOptions: data.subsidiaryOptions,
              departmentOptions: f('scopeDepartments'),
              projectOptions: f('scopeProjects'),
              payComponentOptions: f('payComponentOptions'),
              accountOptions: f('accountOptions'),
              employmentsTruncated: f('employmentsTruncated'),
            },
            f('programBuilderOpen'),
          ),
          widgetBlock(
            'hrm-program-builder-edit',
            {
              closeHref: f('dialogCloseHref'),
              programId: data.programEditSeed?.id ?? '',
              editSeed: data.programEditSeed,
              subsidiaryOptions: data.subsidiaryOptions,
              departmentOptions: f('scopeDepartments'),
              projectOptions: f('scopeProjects'),
              payComponentOptions: f('payComponentOptions'),
              accountOptions: f('accountOptions'),
              employmentsTruncated: f('employmentsTruncated'),
            },
            f('programEditOpen'),
          ),
          widgetBlock(
            'hrm-award-builder',
            {
              closeHref: f('dialogCloseHref'),
              programOptions: f('awardProgramOptions'),
              employmentOptions: f('employmentOptions'),
              defaultCurrency: f('defaultAwardCurrency'),
            },
            f('awardBuilderOpen'),
          ),
          widgetBlock(
            'hrm-program-drawer',
            {
              drawer: data.programDrawer,
              closeHref: f('programCloseHref'),
              canManage: f('canManage'),
              employmentOptions: f('employmentOptions'),
            },
            f('programDrawer'),
          ),
          widgetBlock(
            'hrm-award-drawer',
            {
              drawer: data.awardDrawer,
              closeHref: f('awardCloseHref'),
              canManage: f('canManage'),
              canQueue: f('canQueue'),
            },
            f('awardDrawer'),
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
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadBenefits(authz, sp)
}

export async function benefitsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('benefits.title')
}
