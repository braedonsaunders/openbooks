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
 * Enrollment windows open in a drawer from the enrollment workspace.
 * Builders and record drawers retain their existing URL-driven controls.
 */

const f = ref<BenefitsData>()

// Builders and record actions use the authorized loader's destinations.
export function benefitsSpec(data: BenefitsData): PageSpec {
  const showingOverview = data.portfolioView === 'overview'
  const showingPrograms = data.portfolioView === 'programs'
  const showingRewards = data.portfolioView === 'rewards'
  const showingIncentives = data.portfolioView === 'incentives'
  const showingPayouts = data.portfolioView === 'payouts'
  const awardRows =
    showingRewards ? data.rewardAwardRows : data.payoutAwardRows
  return page({
    route: '/hrm/benefits',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: showingOverview ? f('title') : f('listTitle'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          ...(showingPayouts ? [] : [widget('link-button', {
            href: data.showingEnrolments ? f('newEnrollmentHref') : showingRewards ? f('newAwardHref') : f('newProgramHref'),
            label: data.showingEnrolments ? f('newEnrollmentButton') : showingRewards ? f('newAwardButton') : f('newProgramButton'),
            iconKey: 'plus',
          }, f('canManage'))]),
          ...(data.showingEnrolments ? [widget('link-button', {
            href: f('enrollmentWindowsHref'), label: f('enrollmentWindowsButton'), variant: 'outline',
          })] : []),
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
                  rows: showingIncentives ? data.incentiveProgramRows : data.unifiedProgramRows,
                  ...(showingPrograms ? { typeFilter: data.programTypeFilter } : {}),
                  text: data.programTableText,
                  total: (showingIncentives ? data.incentiveProgramRows : data.unifiedProgramRows).length,
                  truncated: false,
                }),
              ]
            : []),
          ...((showingRewards || showingPayouts) && !data.awardsRefusal
            ? [
                widgetBlock('hrm-award-table', {
                  rows: awardRows,
                  text: data.awardTableText,
                  total: awardRows.length,
                  truncated: data.awardsTruncated,
                }),
              ]
            : []),
          ...(data.showingEnrolments
            ? [
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
          widgetBlock('hrm-benefit-type-cards', {
            cards: data.overview.cards, closeHref: f('dialogCloseHref'), title: f('programTypePickerTitle'),
          }, f('programTypePickerOpen')),
          widgetBlock('hrm-windows-manager', {
            rows: f('windowRows'), closeHref: f('windowsCloseHref'), newHref: f('newWindowHref'), canManage: f('canManage'),
          }, f('windowsManagerOpen')),
          widgetBlock('hrm-benefit-dialog', {
            dialog: f('enrollmentDialog'), closeHref: f('windowsCloseHref'), mode: 'manage',
          }, f('enrollmentDialog')),
          widgetBlock(
            'hrm-window-dialog',
            {
              closeHref: f('enrollmentWindowsHref'),
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
              canConfigureApprovalPolicies: f('canConfigureApprovalPolicies'),
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
              canConfigureApprovalPolicies: f('canConfigureApprovalPolicies'),
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
