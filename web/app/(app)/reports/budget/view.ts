import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  paper,
  ref,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { budgetScenarioOptions, budgetVsActualView } from '../../../../lib/budget-report'
import { orgInfo } from '../../../../lib/data'
import { parseReportQuery } from '../../../../lib/report-filters'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadBudgetDimensionOptions } from '../../../../lib/budgets'

/**
 * The budget-vs-actual statement, split into a loader and a spec.
 *
 * Two things this page settles:
 *
 * 1. The native filter bar sets `sections` from DATA (`Boolean(view)`), and
 *    the spec's controls are static booleans by design — a control that
 *    appears only sometimes is presence, so the spec places TWO filter bars
 *    with complementary loader flags rather than teaching the language to
 *    carry a conditional control.
 * 2. The paper body is a conditional pair — the matrix, or an italic
 *    no-scenarios note — so the loader raises both flags and the spec places
 *    both blocks.
 */

export interface BudgetReportData {
  title: string
  backHref: string
  backLabel: string
  scenarioFilter: {
    paramKey: string
    label: string
    value: string
    options: { value: string; label: string }[]
  }
  hasScenarios: boolean
  noScenarios: boolean
  showSections: boolean
  hideSections: boolean
  canManage: boolean
  manageHref: string
  manageLabel: string
  dimensions: unknown
  exportParams: Record<string, string | undefined>
  company: string
  periodPhrase: string
  emptyNote: string
  wide: boolean
  hasView: boolean
  view: unknown
  currency: string | undefined
  drill: unknown
}

export async function loadBudgetReport(
  sp: Record<string, string | undefined>,
): Promise<BudgetReportData> {
  const t = await getTranslations('reports')
  const tb = await getTranslations('budgets')
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'budgets')
  const q = parseReportQuery(sp)
  const [scenarios, dimensions, org] = await Promise.all([
    budgetScenarioOptions(authz.user.orgId),
    loadBudgetDimensionOptions(authz.user.orgId),
    orgInfo(authz.user.orgId),
  ])

  // With no scenarios there is nothing to compare against, so the loader
  // stops before the view query — the same shape as the native early return.
  const scenarioId =
    scenarios.length === 0
      ? ''
      : sp.scenario && scenarios.some((s) => s.id === sp.scenario)
        ? sp.scenario
        : scenarios[0]!.id
  const labels = {
    actual: t('budget.actual'),
    budget: t('budget.budget'),
    variance: t('budget.variance'),
    variancePct: t('budget.variancePct'),
    revenue: t('pnl.revenue'),
    costOfGoodsSold: t('pnl.costOfGoodsSold'),
    grossProfit: t('pnl.grossProfit'),
    expenses: t('pnl.expenses'),
    netIncome: t('pnl.netIncome'),
    totalOf: (section: string) => t('statement.sectionTotal', { section }),
  }
  const view =
    scenarios.length === 0
      ? null
      : await budgetVsActualView(
          scenarioId,
          authz.user.orgId,
          labels,
          q.dims,
          authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds],
        )

  const scenarioName = scenarios.find((scenario) => scenario.id === scenarioId)?.name
  return {
    title: t('budget.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    scenarioFilter: {
      paramKey: 'scenario',
      label: t('budget.scenario'),
      value: scenarioId,
      options: scenarios.map((scenario) => ({
        value: scenario.id,
        label: t('budget.scenarioOption', {
          name: scenario.name,
          year: scenario.fiscalYear,
          status: tb(`status.${scenario.status}`),
        }),
      })),
    },
    hasScenarios: scenarios.length > 0,
    noScenarios: scenarios.length === 0,
    showSections: scenarios.length > 0 && Boolean(view),
    hideSections: scenarios.length > 0 && !view,
    canManage: can(authz, 'budgets.read'),
    manageHref: '/budgets',
    manageLabel: t('budget.manage'),
    dimensions,
    exportParams: { ...sp, scenario: scenarioId },
    company: org?.name ?? '',
    // With no scenarios at all the native page shows the description instead
    // of a scenario name.
    periodPhrase: scenarios.length === 0 ? t('budget.description') : (scenarioName ?? ''),
    emptyNote: t('budget.noScenarios'),
    wide: (view?.columns.length ?? 0) > 4,
    hasView: Boolean(view),
    view,
    currency: org?.base_currency,
    drill: { dims: q.dims, basis: 'accrual', budgetScenarioId: scenarioId },
  }
}

const f = ref<BudgetReportData>()

export function budgetReportSpec(data: BudgetReportData): PageSpec {
  const manage = widget(
    'link-button',
    { href: data.manageHref, label: data.manageLabel, variant: 'outline', size: 'sm' },
    f('canManage'),
  )
  // `primaryFilter` binds a field, not a literal — the loader assembles the
  // picker and the spec names where it lives.
  return page({
    route: '/reports/budget',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      // No scenarios at all: the native page renders a bare bar with only the
      // manage action, and no scenario picker to choose from.
      {
        ...filterBar({ period: false }, { actions: [manage] }),
        when: f('noScenarios'),
      },
      {
        ...filterBar(
          { period: false, dimensions: true, sections: true },
          {
            primaryFilter: f('scenarioFilter'),
            dimensions: f('dimensions'),
            actions: [
              manage,
              widget('save-view'),
              widget('export-menu', { kind: 'budget', params: data.exportParams }),
            ],
          },
        ),
        when: f('showSections'),
      },
      {
        ...filterBar(
          { period: false, dimensions: true },
          {
            primaryFilter: f('scenarioFilter'),
            dimensions: f('dimensions'),
            actions: [
              manage,
              widget('save-view'),
              widget('export-menu', { kind: 'budget', params: data.exportParams }),
            ],
          },
        ),
        when: f('hideSections'),
      },
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        wide: f('wide'),
        blocks: [
          {
            ...widgetBlock('statement-matrix', {
              view: data.view,
              currency: data.currency,
              drill: data.drill,
            }),
            when: f('hasView'),
          },
          {
            ...textBlock(f('emptyNote'), {
              className: 'py-8 text-center text-slate-400 italic',
            }),
            when: f('noScenarios'),
          },
          {
            ...textBlock(f('emptyNote'), {
              className: 'py-8 text-center text-slate-400 italic',
            }),
            when: f('hideSections'),
          },
        ],
      }),
    ],
  })
}
