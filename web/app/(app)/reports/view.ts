import 'server-only'

import { sql } from 'drizzle-orm'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { frame, page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { ensureReportDefinitions } from '@openbooks/engine/src/reports/ensure-report-definitions.ts'
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
  // Materialise the built-in catalog before reading it. The hub reads
  // `report_definitions` rows, and those rows only exist once something has
  // called `ensureReportDefinitions` — the builder, the definitions API, the
  // payroll evidence pack. An org that had never opened one of those saw a
  // hub with NO built-in reports on it: no Payroll group, no Human-resources
  // group, and nothing to say they were missing. The call is idempotent and
  // refuses to overwrite org-tuned rows.
  if (orgId) await ensureReportDefinitions(orgId)
  const emptySaved = Promise.resolve({ rows: [] as { id: string; name: string; path: string; params: Record<string, string> }[] })
  const emptyDefs = Promise.resolve({ rows: [] as { id: string; slug: string; name: string; description: string | null; kind: string; entity: string | null }[] })
  const [saved, custom, projectsEnabled, payrollEnabled, budgetsEnabled, ordersEnabled, hiddenEntities, hrmEnabled] = await Promise.all([
    orgId
      ? db.execute(sql`select id, name, path, params from saved_reports where org_id = ${orgId} order by created_at desc limit 12`) as Promise<{
          rows: { id: string; name: string; path: string; params: Record<string, string> }[]
        }>
      : emptySaved,
    orgId
      ? db.execute(
          // No LIMIT. The catalog is the point of this page: a cap ordered by
          // `updated_at` meant a module's entire group could vanish because
          // twelve unrelated reports had been edited more recently, and the
          // page would look complete while doing it. Saved views below keep
          // their cap — those really are "the twelve most recent".
          sql`select id, slug, name, description, kind, query->>'entity' as entity from report_definitions where org_id = ${orgId} and coalesce(report_type, 'query') = 'query' order by name`,
        ) as Promise<{
          rows: { id: string; slug: string; name: string; description: string | null; kind: string; entity: string | null }[]
        }>
      : emptyDefs,
    authz ? isFeatureEnabled(authz.user.orgId, 'projects') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'payroll') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'budgets') : Promise.resolve(false),
    authz ? isFeatureEnabled(authz.user.orgId, 'orders') : Promise.resolve(false),
    authz ? hiddenReportEntityKeys(authz) : Promise.resolve<string[]>([]),
    authz ? isFeatureEnabled(authz.user.orgId, 'hrm') : Promise.resolve(false),
  ])

  // Hide definitions over permission-gated or feature-off entities from
  // users who could not run them anyway. A payroll built-in must not fall
  // into the Custom group when Payroll is off.
  const hidden = new Set(hiddenEntities)
  const visibleDefinitions = custom.rows.filter((row) => !row.entity || !hidden.has(row.entity))

  // Built-ins and user-authored reports share ONE definition catalog, but
  // they do not share a hub section. Every built-in is classified into a
  // first-class domain group; Custom & Saved is reserved for definitions the
  // organization actually authored plus saved views. The old catch-all made
  // CRM, inventory, allocations and AI governance look like custom reports.
  const entityCategory = (row: { entity: string | null }) =>
    row.entity ? REPORT_ENTITY_MAP[row.entity]?.category?.toLowerCase() : undefined
  const builtInDefinitions = visibleDefinitions.filter((row) => row.kind === 'built_in')
  const customDefinitions = visibleDefinitions.filter((row) => row.kind !== 'built_in')
  const receivablesPayablesDefinitions = builtInDefinitions.filter((row) =>
    row.slug === 'ap-aging-by-vendor' || row.slug === 'open-ar-by-customer',
  )
  const allocationDefinitions = builtInDefinitions.filter((row) => row.slug.startsWith('allocation-'))
  const ledgerDefinitions = builtInDefinitions.filter((row) =>
    entityCategory(row) === 'general_ledger'
    && !receivablesPayablesDefinitions.some((item) => item.id === row.id)
    && !allocationDefinitions.some((item) => item.id === row.id),
  )
  const crmDefinitions = builtInDefinitions.filter((row) => entityCategory(row) === 'crm')
  const inventoryDefinitions = builtInDefinitions.filter((row) => entityCategory(row) === 'inventory')
  const aiDefinitions = builtInDefinitions.filter((row) => entityCategory(row) === 'ai governance')
  const payrollDefinitions = payrollEnabled
    ? builtInDefinitions.filter((row) => entityCategory(row) === 'payroll')
    : []
  // Workforce reports are the HR module's reports — the Reports module is
  // their ONE home (by review: no HR-side reports page), so every definition
  // over a governed HRM entity gets a group of its own here. The definitions
  // themselves are ordinary rows in the one report catalog; there is no
  // parallel HRM source catalog.
  const hrmDefinitions = hrmEnabled
    ? builtInDefinitions.filter((row) => entityCategory(row) === 'hrm')
    : []
  const classifiedBuiltInIds = new Set([
    ...receivablesPayablesDefinitions,
    ...allocationDefinitions,
    ...ledgerDefinitions,
    ...crmDefinitions,
    ...inventoryDefinitions,
    ...aiDefinitions,
    ...payrollDefinitions,
    ...hrmDefinitions,
  ].map((row) => row.id))
  // A future built-in category must still never leak into Custom & Saved.
  // Until it receives a more specific domain placement it is visibly listed
  // under Other reports, making the missing classification reviewable.
  const otherBuiltInDefinitions = builtInDefinitions.filter(
    (row) => !classifiedBuiltInIds.has(row.id),
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

  const definitionCards = (
    definitions: typeof builtInDefinitions,
    icon: string,
    fallbackDescription: string,
  ): HubCard[] => definitions.map((definition) => ({
    href: `/reports/custom/run/${definition.id}`,
    title: definition.name,
    desc: definition.description ?? fallbackDescription,
    icon,
  }))

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
      cards: [
        card('generalLedger', '/reports/general-ledger', 'BookOpen'),
        card('journal', '/reports/journal', 'NotebookPen'),
        ...definitionCards(ledgerDefinitions, 'BookOpen', t('hub.cards.builtInDescription')),
      ],
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
        ...definitionCards(receivablesPayablesDefinitions, 'Receipt', t('hub.cards.builtInDescription')),
      ],
    },
    ...(allocationDefinitions.length > 0 ? [{
      key: 'allocations',
      label: t('hub.groups.allocations'),
      accent: 'violet',
      cards: definitionCards(allocationDefinitions, 'Network', t('hub.cards.builtInDescription')),
    } satisfies HubGroup] : []),
    ...(crmDefinitions.length > 0 ? [{
      key: 'crm',
      label: t('hub.groups.crm'),
      accent: 'teal',
      cards: definitionCards(crmDefinitions, 'BriefcaseBusiness', t('hub.cards.builtInDescription')),
    } satisfies HubGroup] : []),
    ...(inventoryDefinitions.length > 0 ? [{
      key: 'inventory',
      label: t('hub.groups.inventory'),
      accent: 'amber',
      cards: definitionCards(inventoryDefinitions, 'Boxes', t('hub.cards.builtInDescription')),
    } satisfies HubGroup] : []),
    ...(aiDefinitions.length > 0 ? [{
      key: 'aiGovernance',
      label: t('hub.groups.aiGovernance'),
      accent: 'sky',
      cards: definitionCards(aiDefinitions, 'BrainCircuit', t('hub.cards.builtInDescription')),
    } satisfies HubGroup] : []),
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
      cards: definitionCards(payrollDefinitions, 'HandCoins', t('hub.cards.payrollDescription')),
    } satisfies HubGroup] : []),
    ...(hrmDefinitions.length > 0 ? [{
      key: 'hrm',
      label: t('hub.groups.hrm'),
      accent: 'teal',
      cards: definitionCards(hrmDefinitions, 'Users', t('hub.cards.hrmDescription')),
    } satisfies HubGroup] : []),
    ...(otherBuiltInDefinitions.length > 0 ? [{
      key: 'otherBuiltIns',
      label: t('hub.groups.other'),
      accent: 'slate',
      cards: definitionCards(otherBuiltInDefinitions, 'FileText', t('hub.cards.builtInDescription')),
    } satisfies HubGroup] : []),
    {
      key: 'custom',
      label: t('hub.groups.custom'),
      accent: 'slate',
      cards: [
        { href: '/reports/custom', title: t('hub.customStudio.title'), desc: t('hub.customStudio.description'), icon: 'Sparkles' },
        ...customDefinitions.filter((c) => projectsEnabled || c.kind !== 'project-profitability').map((c) => ({
          href: `/reports/custom/run/${c.id}`,
          title: c.name,
          desc: c.description ?? t('custom.kind.custom'),
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

export function reportsHubSpec(): PageSpec {
  return page({
    route: '/reports',
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
