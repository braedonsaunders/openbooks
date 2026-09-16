import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  page,
  ref,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { pickString } from '../../../../../lib/list-params'
import { getMoneyFormatter } from '../../../../../lib/money-server'
import { getAgentRunStats, getAgentsOverview } from '../../../../../lib/setup/agents'

/**
 * Agents overview — every pack from the engine registry with its enabled
 * switch, cadence, last run, open findings, run-now and a link to its policy
 * page. Split into a loader and a spec.
 *
 * The page composes the SHARED components (the `[entity]` setup precedent):
 * an in-content heading + `setup-description`, header `link-button` actions,
 * the generic `kpi-strip`, one `attention-list` warning when the module
 * switch is off, and a card-wrapped spec `table` (app variant, shared sort
 * headers). THE LOADER COMPUTES: pack names, status/cadence/run/findings
 * lines and every KPI value resolve here via `getTranslations`, so the spec
 * binds and never formats. The ONLY custom island is the row-actions cell
 * (`agents-pack-actions`: the fenced enable switch + run-now, which own
 * `useState` and `fetch` mutations against `/api/admin/setup/agents/*` and
 * toast + `router.refresh()` on completion — the FeaturesWorkspace
 * precedent). Its button/toast copy resolves inside the island via hooks on
 * the existing `setup.agents.overview` keys, so no message key is invented.
 *
 * Loader work: the `admin.setup.manage` gate, one `getAgentsOverview` call,
 * one `getAgentRunStats` call for the KPI strip, and the `?sort=`/`?dir=`
 * sort over the pack rows. The Continuous Close feature flag travels hoisted
 * (every row carries the same value) so the island can fence the switches
 * without re-deriving — the server refuses the enable too (409).
 */

const OVERVIEW_SORTS = ['pack', 'status', 'findings', 'lastRun'] as const
export type AgentsOverviewSort = (typeof OVERVIEW_SORTS)[number]

export interface AgentsOverviewRow {
  id: string
  agentKey: string
  name: string
  description: string
  enabled: boolean
  policy: Record<string, unknown>
  featureEnabled: boolean
  statusLabel: string
  statusVariant: 'success' | 'secondary'
  cadenceLabel: string
  detectorsLine: string
  lastRunLine: string
  lastRunStartedAt: string
  findingsLine: string
  openFindings: number
  configureLabel: string
  configureHref: string
  reviewHref: string
}

export interface AgentsOverviewKpi {
  label: string
  value: string
}

export interface AgentsOverviewData {
  title: string
  description: string
  docHref: string
  learnMore: string
  libraryHref: string
  libraryLabel: string
  activityHref: string
  activityLabel: string
  hasFeatureOff: boolean
  attentionItems: { tone: 'warning'; text: string; href: string }[]
  attentionAllClear: string
  kpis: AgentsOverviewKpi[]
  colPack: string
  colStatus: string
  colSchedule: string
  colLastRun: string
  colFindings: string
  colPolicy: string
  colActions: string
  actionsLabel: string
  sort: AgentsOverviewSort
  dir: 'asc' | 'desc'
  rows: AgentsOverviewRow[]
}

export async function loadAgentsOverview(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<AgentsOverviewData> {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const rawSort = pickString(sp.sort)
  const sort: AgentsOverviewSort = (OVERVIEW_SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as AgentsOverviewSort)
    : 'pack'
  const dir = pickString(sp.dir) === 'desc' ? 'desc' : 'asc'
  const [rows, stats, { money: formatMoney }] = await Promise.all([
    getAgentsOverview(authz.user.orgId),
    getAgentRunStats(authz.user.orgId),
    getMoneyFormatter(authz.user.orgId),
  ])
  const featureEnabled = rows[0]?.featureEnabled ?? false
  const mapped: AgentsOverviewRow[] = rows.map((row) => {
    const name = t(`setup.agents.packs.${row.agentKey}.title`)
    const activeDetectors = row.policy.detectors.filter((detector) => detector.enabled).length
    const lastRunLine = row.lastRun
      ? t('setup.agents.overview.lastRun', {
          date: new Date(row.lastRun.startedAt).toLocaleString(),
          status: t(`setup.agents.overview.runStatus.${row.lastRun.status}`),
        })
      : t('setup.agents.overview.neverRun')
    const nextRunLine =
      row.policy.nextRunAt && featureEnabled && row.policy.enabled && row.policy.automaticRuns
        ? ` · ${t('setup.agents.overview.nextRun', {
            date: new Date(row.policy.nextRunAt).toLocaleString(),
          })}`
        : ''
    return {
      id: row.agentKey,
      agentKey: row.agentKey,
      name,
      description: t(`setup.agents.packs.${row.agentKey}.description`),
      enabled: row.policy.enabled,
      policy: row.policy as unknown as Record<string, unknown>,
      featureEnabled,
      statusLabel: t(`setup.agents.overview.${row.policy.enabled ? 'enabled' : 'disabled'}`),
      statusVariant: row.policy.enabled ? 'success' : 'secondary',
      cadenceLabel: row.policy.automaticRuns
        ? t(`setup.agents.overview.cadences.${row.policy.cadence}`)
        : t('setup.agents.overview.manualOnly'),
      detectorsLine: `${t('setup.agents.overview.controlsEnabled', {
        count: activeDetectors,
        total: row.policy.detectors.length,
      })} · ${t('setup.agents.overview.materialitySummary', {
        amount: formatMoney(row.policy.materialityThreshold),
      })}`,
      lastRunLine: `${lastRunLine}${nextRunLine}`,
      lastRunStartedAt: row.lastRun?.startedAt ?? '',
      findingsLine: t('setup.agents.overview.openFindings', { count: row.openFindings }),
      openFindings: row.openFindings,
      configureLabel: t('setup.agents.overview.configure'),
      configureHref: `/admin/setup/agents/${row.agentKey}`,
      reviewHref: '/agents',
    }
  })
  const rank = (row: AgentsOverviewRow): string | number => {
    switch (sort) {
      case 'status':
        return row.enabled ? 0 : 1
      case 'findings':
        return row.openFindings
      case 'lastRun':
        return row.lastRunStartedAt
      case 'pack':
      default:
        return row.name
    }
  }
  mapped.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    const order = typeof ra === 'number' && typeof rb === 'number' ? ra - rb : String(ra).localeCompare(String(rb))
    return dir === 'desc' ? -order : order
  })
  const enabledCount = mapped.filter((row) => row.enabled).length
  const openTotal = mapped.reduce((sum, row) => sum + row.openFindings, 0)
  return {
    title: t('setup.agents.overview.title'),
    description: t('setup.agents.overview.description'),
    docHref: '/docs/setup-agents-group',
    learnMore: t('setup.agents.overview.guideLink'),
    libraryHref: '/admin/setup/agents/library',
    libraryLabel: t('setup.agents.nav.library'),
    activityHref: '/admin/setup/agents/activity',
    activityLabel: t('setup.agents.nav.activity'),
    hasFeatureOff: !featureEnabled,
    attentionItems: featureEnabled
      ? []
      : [
          {
            tone: 'warning',
            text: t('setup.agents.overview.featureOff'),
            href: '/admin/setup/features',
          },
        ],
    attentionAllClear: '',
    kpis: [
      {
        label: t('setup.agents.overview.kpis.enabled'),
        value: t('setup.agents.overview.kpis.enabledValue', { count: enabledCount, total: mapped.length }),
      },
      { label: t('setup.agents.overview.kpis.openFindings'), value: String(openTotal) },
      { label: t('setup.agents.overview.kpis.runs7d'), value: String(stats.runs7d) },
      { label: t('setup.agents.overview.kpis.failed7d'), value: String(stats.failed7d) },
    ],
    colPack: t('setup.agents.overview.columns.pack'),
    colStatus: t('setup.agents.overview.columns.status'),
    colSchedule: t('setup.agents.overview.columns.schedule'),
    colLastRun: t('setup.agents.overview.columns.lastRun'),
    colFindings: t('setup.agents.overview.columns.findings'),
    colPolicy: t('setup.agents.overview.columns.policy'),
    colActions: t('setup.agents.overview.columns.actions'),
    actionsLabel: t('setup.agents.overview.columns.actions'),
    sort,
    dir,
    rows: mapped,
  }
}

const f = ref<AgentsOverviewData>()
const item = field

export function agentsOverviewSpec(data: AgentsOverviewData): PageSpec {
  return page({
    route: '/admin/setup/agents',
    // The setup workspace renders its own shell around every setup page, so
    // a second page layout would nest the chrome — the [entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        grid('flex items-start justify-between gap-3', [
          grid('min-w-0', [
            heading(2, f('title'), 'text-lg font-semibold text-slate-900 dark:text-slate-100'),
            widgetBlock('setup-description', {
              description: f('description'),
              docHref: data.docHref,
              learnMore: data.learnMore,
            }),
          ]),
          grid('flex shrink-0 items-center gap-2', [
            widgetBlock('link-button', {
              href: data.libraryHref,
              label: data.libraryLabel,
              variant: 'outline',
              size: 'sm',
            }),
            widgetBlock('link-button', {
              href: data.activityHref,
              label: data.activityLabel,
              variant: 'outline',
              size: 'sm',
            }),
          ]),
        ]),
        {
          ...widgetBlock('attention-list', {
            items: data.attentionItems,
            allClear: data.attentionAllClear,
          }),
          when: f('hasFeatureOff'),
        },
        widgetBlock('kpi-strip', { items: data.kpis }),
        grid('rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            sorting: { basePath: '/admin/setup/agents', sort: f('sort'), dir: f('dir') },
            columns: [
              column(f('colPack'), text(item('name'), { suffix: { field: item('description'), className: 'mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400' } }), {
                sort: 'pack',
                className: 'font-medium',
              }),
              column(f('colStatus'), badge(item('statusLabel'), { variant: item('statusVariant') }), {
                sort: 'status',
              }),
              column(f('colSchedule'), text(item('cadenceLabel'), { suffix: { field: item('detectorsLine'), className: 'mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400' } })),
              column(f('colLastRun'), text(item('lastRunLine')), { sort: 'lastRun' }),
              column(
                f('colFindings'),
                link(item('findingsLine'), item('reviewHref'), 'font-medium text-teal-700 underline dark:text-teal-300'),
                { sort: 'findings' },
              ),
              column(f('colPolicy'), link(item('configureLabel'), item('configureHref'), 'font-medium text-teal-700 underline dark:text-teal-300')),
              column(f('colActions'), widgetCell('agents-pack-actions', {
                agentKey: item('agentKey'),
                policy: item('policy'),
                packTitle: item('name'),
                enabled: item('enabled'),
                featureEnabled: item('featureEnabled'),
              }), { srOnlyHeader: true }),
            ],
          }),
        ]),
      ]),
    ],
  })
}
