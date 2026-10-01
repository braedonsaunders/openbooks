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
  panel,
  ref,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadBenefits, type BenefitsData } from '../../../../lib/hrm/benefits'

/**
 * The Benefits tab, split into a loader and a spec.
 *
 * The default overview is the portfolio cockpit in the purchasing
 * composition: native statTile vitals, native tables for delivered and
 * awaiting money (one row per currency — mixed currencies never total),
 * the native attention-list queue, the six program-type cards as one panel
 * body, and native report links above the enrollment-windows table.
 * Focused views narrow the page: programs (employer-defined programs
 * beside the rehomed insured-plan section), windows, enrolments, rewards,
 * incentives, and payouts. Windows and enrolments keep their existing
 * tables and operations; the window-status filter rides the shared
 * `list-toolbar` beside them.
 *
 * The page's primary action is the shared 'link-button' widget ("New
 * program") FIRST in the page header, then the module-home-tabs strip the
 * shell owns. "New window" and "New award" stay section-level actions, so
 * the header never carries competing create buttons. The program and award
 * builders and drawers open from URL search params through small client
 * islands; pending rows carry the approve island in the row-action cell.
 * Forms use @openbooks/ui primitives, never bespoke buttons or hand-rolled
 * tables.
 */

const f = ref<BenefitsData>()

// The registry builds every spec from its data alone, so the base path
// defaults to the literal route the spec declares.
export function benefitsSpec(data: BenefitsData, basePath: string = '/hrm/benefits'): PageSpec {
  const showingOverview = data.portfolioView === 'overview'
  const showingWindows = data.portfolioView === 'windows' || showingOverview
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
          widget('link-button', { href: f('newProgramHref'), label: f('newProgramButton'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // A computed refusal (unknown segment) renders with its message
      // intact — never a success, never an empty table.
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      {
        ...grid('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4', [
          ...(showingOverview
            ? [
                grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4', [
                  statTile({ iconKey: 'heart-pulse', accent: 'teal', label: f('overview.vitalsLabels.activePrograms'), value: f('tiles.activePrograms') }),
                  statTile({ iconKey: 'calendar-clock', accent: 'sky', label: f('overview.vitalsLabels.openWindows'), value: f('tiles.openWindows') }),
                  statTile({ iconKey: 'timer', accent: 'amber', label: f('overview.vitalsLabels.pendingApprovals'), value: f('tiles.pendingApprovals') }),
                  statTile({ iconKey: 'wallet', accent: 'violet', label: f('overview.vitalsLabels.queuedPayouts'), value: f('tiles.queuedPayouts') }),
                ]),
                // Partial vitals (aggregate failed, page-derived fallback)
                // render beside their named refusal — never as clean totals.
                widgetBlock(
                  'empty-state',
                  { title: data.vitalsRefusal?.title ?? '', description: data.vitalsRefusal?.message },
                  f('vitalsRefusal'),
                ),
                grid('grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2', [
                  panel({ title: f('deliveredTitle'), iconKey: 'circle-check', className: 'shrink-0', blocks: [table({
                    variant: 'app',
                    rows: f('deliveredRows'),
                    rowKey: item('currency'),
                    columns: [
                      column(f('moneyColumns.currency'), text(item('currency'))),
                      column(f('moneyColumns.amount'), text(item('display')), { align: 'right', className: 'tabular-nums' }),
                    ],
                    empty: { title: f('deliveredTitle'), description: f('deliveredEmpty') },
                  })] }),
                  panel({ title: f('awaitingTitle'), iconKey: 'timer', className: 'shrink-0', blocks: [table({
                    variant: 'app',
                    rows: f('awaitingRows'),
                    rowKey: item('currency'),
                    columns: [
                      column(f('moneyColumns.currency'), text(item('currency'))),
                      column(f('moneyColumns.amount'), text(item('display')), { align: 'right', className: 'tabular-nums' }),
                    ],
                    empty: { title: f('awaitingTitle'), description: f('awaitingEmpty') },
                  })] }),
                ]),
                panel({
                  title: f('overview.attentionTitle'),
                  iconKey: 'triangle-alert',
                  bodyClassName: 'p-0',
                  className: 'shrink-0',
                  blocks: [
                    widgetBlock('attention-list', {
                      items: data.overview.attention,
                      allClear: data.overview.attentionEmpty,
                    }),
                  ],
                }),
                panel({
                  title: f('overview.vitalsLabels.cardsTitle'),
                  iconKey: 'list-checks',
                  className: 'shrink-0',
                  blocks: [widgetBlock('hrm-benefit-type-cards', { cards: data.overview.cards })],
                }),
                widgetBlock('directory-section', { title: data.overview.reportsTitle, items: data.overview.reportLinks.map((report) => ({ href: report.href, label: report.label, iconKey: 'chart-no-axes-combined' })) }),
                widgetBlock(
                  'empty-state',
                  { title: data.reportsRefusal?.title ?? '', description: data.reportsRefusal?.message },
                  f('reportsRefusal'),
                ),
              ]
            : []),
          // A refused programs read renders with its message intact beside
          // the sections it blocks — never a success around missing rows.
          widgetBlock(
            'empty-state',
            { title: data.programsRefusal?.title ?? '', description: data.programsRefusal?.message },
            f('programsRefusal'),
          ),
          widgetBlock(
            'empty-state',
            { title: data.awardsRefusal?.title ?? '', description: data.awardsRefusal?.message },
            f('awardsRefusal'),
          ),
          // A refused selector lookup renders beside the builders — an empty
          // picker never pretends its catalog is empty.
          widgetBlock(
            'empty-state',
            { title: data.optionsRefusal?.title ?? '', description: data.optionsRefusal?.message },
            f('optionsRefusal'),
          ),
          ...(showingPrograms || showingIncentives
            ? [
                widgetBlock('hrm-program-table', {
                  rows: showingIncentives ? data.incentiveProgramRows : data.programRows,
                  text: data.programTableText,
                  total: (showingIncentives ? data.incentiveProgramRows : data.programRows).length,
                  truncated: false,
                }),
              ]
            : []),
          ...(showingRewards || showingIncentives || showingPayouts
            ? [
                widgetBlock('link-button', { href: f('newAwardHref'), label: f('newAwardButton'), iconKey: 'plus' }, f('canManage')),
                widgetBlock('hrm-award-table', {
                  rows: awardRows,
                  text: data.awardTableText,
                  total: data.awardsTotal,
                  truncated: data.awardsTruncated,
                }),
              ]
            : []),
          ...(showingWindows
            ? [
                widgetBlock('link-button', { href: f('newWindowHref'), label: f('newWindowButton'), iconKey: 'plus' }, f('canManage')),
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
