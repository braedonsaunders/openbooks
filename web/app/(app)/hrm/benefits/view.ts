import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
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
 * Enrollment windows open in a drawer from Employee benefits.
 * Builders and record drawers retain their existing URL-driven controls.
 */

const f = ref<BenefitsData>()

// Builders and record actions use the authorized loader's destinations.
export function benefitsSpec(data: BenefitsData): PageSpec {
  const showingOverview = data.portfolioView === 'overview'
  const showingPrograms = data.portfolioView === 'programs'
  const showingDelivery = data.portfolioView === 'delivery'
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
          ...(!showingDelivery ? [widget('link-button', {
            href: f('newProgramHref'), label: f('newProgramButton'), iconKey: 'plus',
          }, f('canManage'))] : []),
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
          ...(showingPrograms && !data.programsRefusal
            ? [
                widgetBlock('hrm-program-table', {
                  rows: data.unifiedProgramRows, typeFilter: data.programTypeFilter,
                  text: data.programTableText,
                  total: data.unifiedProgramRows.length,
                  truncated: false,
                }),
              ]
            : []),
          ...(showingDelivery && !data.awardsRefusal && !data.programsRefusal
            ? [
                widgetBlock('hrm-benefit-delivery-table', {rows: data.deliveryRows, text: data.awardTableText}),
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
              currencyOptions: f('currencyOptions'),
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
              currencyOptions: f('currencyOptions'),
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
              initialProgramId: data.programEditSeed?.id ?? data.programRows.find(row => row.programHref === data.dialogCloseHref)?.id,
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
