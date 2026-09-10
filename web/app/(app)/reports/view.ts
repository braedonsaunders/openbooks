import 'server-only'

import { sql } from 'drizzle-orm'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { frame, page, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { getAuthz, can } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { hiddenReportEntityKeys } from '../../../lib/report-authz'

/**
 * The reports hub, split into a loader and a spec.
 *
 * The page is an interactive island: `ReportsHub` owns client-side search
 * state, the hub header (a bespoke h1, not PageHeader) and the New-report
 * create flow, so the spec places the whole content through one widget —
 * the same doctrine as the file cabinet, whose interactive islands stay
 * whole while the spec owns the page structure that is actually static.
 * There is exactly one ReportsHub; no near-duplicate exists behind another
 * registry entry, so no second component is introduced here. The outer
 * `PageContainer` shell (scroll wrapper + centered container + fade-in) is
 * likewise chrome the grid vocabulary cannot name, so it arrives as a
 * `page-container` frame the coordinator registers around the widget.
 *
 * Loader work copied verbatim from page.tsx: the reports.create gate, the
 * saved/custom definition queries, the four feature probes, the
 * entity-visibility filter (a payroll built-in must not fall into Custom
 * when Payroll is off), the payroll-first-class split, and every
 * feature-gated group and card filter. Query-string building for saved
 * views (`new URLSearchParams`) runs in the loader, not the spec.
 */

type HubCard = { href: string; title: string; desc: string; icon: string }
type HubGroup = { key: string; label: string; accent: string; cards: HubCard[] }

export interface ReportsHubData {
  title: string
  description: string
  groups: HubGroup[]
  canCreate: boolean
}

export async function loadReportsHub(): Promise<ReportsHubData> {
  const t = await getTranslations('reports')
  const tc = await getTranslations('analytics.trueCost')
  const authz = await getAuthz()
  const canCreate = !!authz && (can(authz, 'reports.create') || can(authz, '*'))

  const orgId = authz?.user.orgId
  const emptySaved = Promise.resolve({ rows: [] as { id: string; name: string; path: string; params: Record<string, string> }[] })
  const emptyDefs = Promise.resolve({ rows: [] as { id: string; name: string; kind: string; entity: string | null }[] })
  const [saved, custom, projectsEnabled, payrollEnabled, budgetsEnabled, ordersEnabled, hiddenEntities] = await Promise.all([
    orgId
      ? db.execute(sql`select id, name, path, params from saved_reports where org_id = ${orgId} order by created_at desc limit 12`) as Promise<{
          rows: { id: string; name: string; path: string; params: Record<string, string> }[]
        }>
      : emptySaved,
    orgId
      ? db.execute(
          sql`select id, name, kind, query->>'entity' as entity from report_definitions where org_id = ${orgId} and coalesce(report_type, 'query') = 'query' order by updated_at desc limit 12`,
        ) as Promise<{
          rows: { id: string; name: string; kind: string; entity: string | null }[]
        }>
      : emptyDefs,
    authz ? isFeatureEnabled(authz.user.orgId, 'projects') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'payroll') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'budgets') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'orders') : Promise.resolve(false),
    authz ? hiddenReportEntityKeys(authz) : Promise.resolve<string[]>([]),
  ])

  // Hide definitions over permission-gated or feature-off entities from
  // users who could not run them anyway. A payroll built-in must not fall
  // into the Custom group when Payroll is off.
  const hidden = new Set(hiddenEntities)
  const visibleDefinitions = custom.rows.filter((row) => !row.entity || !hidden.has(row.entity))

  // Built-in reports over module entities are FIRST-CLASS: they get their own
  // hub group beside the standard statements. Custom keeps the rest.
  const entityCategory = (row: { entity: string | null }) =>
    row.entity ? REPORT_ENTITY_MAP[row.entity]?.category : undefined
  const payrollDefinitions = payrollEnabled
    ? visibleDefinitions.filter((row) => row.kind === 'built_in' && entityCategory(row) === 'payroll')
    : []
  const otherDefinitions = visibleDefinitions.filter(
    (row) => !payrollDefinitions.some((p) => p.id === row.id),
  )

  const card = (key: string, href: string, icon: string) => ({
    href,
    title: t(`hub.cards.${key}Title`),
    desc: t(`hub.cards.${key}Description`),
    icon,
  })

  // AR/AP aging split into four distinct reports (side × summary/detail).
  const agingCard = (side: 'ar' | 'ap', view: 'summary' | 'detail') => ({
    href: `/reports/aging?side=${side}${view === 'detail' ? '&view=detail' : ''}`,
    title: `${side === 'ap' ? t('aging.payablesTitle') : t('aging.receivablesTitle')} · ${view === 'detail' ? t('aging.detail') : t('aging.summary')}`,
    desc: t('hub.cards.agingDescription'),
    icon: 'CalendarClock',
  })

  const groups: HubGroup[] = [
    {
      key: 'financial',
      label: t('hub.groups.financial'),
      accent: 'teal',
      cards: [
        card('pnl', '/reports/pnl', 'FileText'),
        card('balanceSheet', '/reports/balance-sheet', 'Scale'),
        card('cashFlow', '/reports/cash-flow', 'Waves'),
        card('cashFlowIndirect', '/reports/cash-flow-indirect', 'Waves'),
        card('trialBalance', '/reports/trial-balance', 'ClipboardList'),
      ],
    },
    {
      key: 'ledger',
      label: t('hub.groups.ledger'),
      accent: 'sky',
      cards: [card('generalLedger', '/reports/general-ledger', 'BookOpen'), card('journal', '/reports/journal', 'NotebookPen')],
    },
    {
      key: 'receivablesPayables',
      label: t('hub.groups.receivablesPayables'),
      accent: 'violet',
      cards: [
        agingCard('ar', 'summary'),
        agingCard('ar', 'detail'),
        agingCard('ap', 'summary'),
        agingCard('ap', 'detail'),
        card('registers', '/reports/registers?side=ar', 'Receipt'),
        card('receivables', '/reports/partners?kind=receivable', 'Wallet'),
        card('payables', '/reports/partners?kind=payable', 'Landmark'),
      ],
    },
    ...(ordersEnabled ? [{
      key: 'orders',
      label: t('hub.groups.orders'),
      accent: 'teal',
      cards: [card('orders', '/reports/orders', 'ClipboardList')],
    } satisfies HubGroup] : []),
    ...(budgetsEnabled ? [{
      key: 'budgeting',
      label: t('hub.groups.budgeting'),
      accent: 'amber',
      cards: [card('budget', '/reports/budget', 'Target')],
    } satisfies HubGroup] : []),
    ...(projectsEnabled ? [{
      key: 'projects',
      label: t('hub.groups.projects'),
      accent: 'sky',
      cards: [card('projectProfitability', '/reports/project-profitability', 'Coins'),
        { href: '/reports/true-cost', title: tc('title'), desc: tc('summary.compositeRate'), icon: 'Calculator' }],
    } satisfies HubGroup] : []),
    ...(payrollDefinitions.length > 0 ? [{
      key: 'payroll',
      label: t('hub.groups.payroll'),
      accent: 'emerald',
      cards: payrollDefinitions.map((c) => ({
        href: `/reports/custom/run/${c.id}`,
        title: c.name,
        desc: t('hub.cards.payrollDescription'),
        icon: 'HandCoins',
      })),
    } satisfies HubGroup] : []),
    {
      key: 'custom',
      label: t('hub.groups.custom'),
      accent: 'slate',
      cards: [
        { href: '/reports/custom', title: t('hub.customStudio.title'), desc: t('hub.customStudio.description'), icon: 'Sparkles' },
        ...otherDefinitions.filter((c) => projectsEnabled || c.kind !== 'project-profitability').map((c) => ({
          href: `/reports/custom/run/${c.id}`,
          title: c.name,
          desc: c.kind === 'built_in' ? t('custom.kind.builtIn') : t('custom.kind.custom'),
          icon: 'Coins',
        })),
        ...saved.rows.filter((s) =>
          (projectsEnabled || !s.path.startsWith('/reports/project-profitability'))
          && (budgetsEnabled || !s.path.startsWith('/reports/budget'))
          && (ordersEnabled || !s.path.startsWith('/reports/orders'))
        ).map((s) => {
          const qs = new URLSearchParams(s.params ?? {}).toString()
          return { href: `${s.path}${qs ? `?${qs}` : ''}`, title: s.name, desc: t('hub.savedViews'), icon: 'Bookmark' }
        }),
      ],
    },
  ]

  return {
    title: t('hub.title'),
    description: t('hub.description'),
    groups,
    canCreate,
  }
}

const f = ref<ReportsHubData>()

export function reportsHubSpec(data: ReportsHubData): PageSpec {
  return page({
    // The hub content is one client-interactive island (search state, the
    // h1 header, the New-report create flow); the PageContainer shell is
    // chrome around it. Both arrive whole — the spec owns neither.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        widgetBlock('reports-hub', {
          title: f('title'),
          description: f('description'),
          groups: f('groups'),
          canCreate: f('canCreate'),
        }),
      ]),
    ],
  })
}
