import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  heading,
  number,
  page,
  ref,
  table,
  text,
  widgetBlock,
  widgetCell,
  pagination,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../../lib/authz'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import { dateTime } from '../../../../../../lib/format'
import {
  AGENT_RUN_STATUSES,
  CONTINUOUS_CLOSE_AGENT_KEYS,
  listAgentRuns,
  type AgentActivitySort,
  type AgentRunStatus,
} from '../../../../../../lib/setup/agents'
import {
  FINDING_SINCE_WINDOWS,
  findingsSinceIso,
  type FindingSince,
} from '../../../../../../lib/list/agent-findings'
import { parseListParams, pickString } from '../../../../../../lib/list-params'

/**
 * Agents activity — run envelopes across packs (status, duration, findings,
 * errors) with re-run and a link into findings. Split into a loader and a spec.
 *
 * The page composes the SHARED components (the `[entity]` setup precedent):
 * an in-content heading + `setup-description`, URL-backed `filter-chips` for
 * pack, status and since (the inbox filter-bar precedent — stable day/week
 * keys the loader maps to ISO lookbacks), a card-wrapped spec `table` (app
 * variant, shared sort headers over pack/status/started), the server
 * `pagination` block driven by the read-model total, and the shared
 * `empty-state` when no runs match. THE LOADER COMPUTES: pack names,
 * trigger/status/duration lines and the filter options resolve here via
 * `getTranslations`. The ONLY custom island is the actions cell
 * (`agents-run-actions`: findings link + re-run, which POSTs to the per-pack
 * run route and toasts + `router.refresh()` like the overview run-now so the
 * server-paged table reloads).
 *
 * Loader work: the `admin.setup.manage` gate, the `?agent=`/`?status=`/
 * `?since=` whitelists (an unknown value degrades to unfiltered, never a
 * 404 — a filter is not a resource), and one `listAgentRuns` call with the
 * parsed `?sort=`/`?dir=`/`?page=` window.
 */

const ACTIVITY_SORTS = ['started', 'status', 'pack'] as const

export interface AgentActivityRowView {
  id: string
  agentKey: string
  packName: string
  triggerLabel: string
  statusLabel: string
  statusVariant: 'success' | 'destructive' | 'secondary' | 'outline'
  startedLine: string
  durationLine: string
  detected: number
  autoResolved: number
  findingsHref: string
  findingsLabel: string
}

export interface AgentsActivityData {
  title: string
  description: string
  docHref: string
  learnMore: string
  backHref: string
  backLabel: string
  filterLabel: string
  filterAll: string
  filterOptions: { value: string; label: string }[]
  statusAll: string
  statusOptions: { value: string; label: string }[]
  sinceLabel: string
  sinceAll: string
  sinceOptions: { value: string; label: string }[]
  currentParams: Record<string, string | string[] | undefined>
  colPack: string
  colTrigger: string
  colStatus: string
  colStarted: string
  colDuration: string
  colDetected: string
  colResolved: string
  colActions: string
  hasRows: boolean
  empty: boolean
  emptyTitle: string
  emptyDescription: string
  sort: AgentActivitySort
  dir: 'asc' | 'desc'
  total: number
  currentPage: number
  perPage: number
  rows: AgentActivityRowView[]
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export async function loadAgentsActivity(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<AgentsActivityData> {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const params = parseListParams(sp, {
    sort: 'started',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ACTIVITY_SORTS,
  })
  const rawAgent = pickString(sp.agent)
  const agentKey = rawAgent && isContinuousCloseAgentKey(rawAgent) ? rawAgent : undefined
  const rawStatus = pickString(sp.status)
  const status: AgentRunStatus | undefined =
    rawStatus && (AGENT_RUN_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as AgentRunStatus)
      : undefined
  // Stable day/week keys like the inbox — the loader maps them to ISO
  // lookback instants so shared links never rot; unknown degrades to
  // unfiltered, never a 404.
  const rawSince = pickString(sp.since)
  const sinceKey: FindingSince | undefined =
    rawSince && (Object.keys(FINDING_SINCE_WINDOWS) as string[]).includes(rawSince)
      ? (rawSince as FindingSince)
      : undefined
  const result = await listAgentRuns(authz.user.orgId, {
    agentKey,
    status,
    startedAfter: findingsSinceIso(sinceKey),
    limit: params.perPage,
    offset: (params.page - 1) * params.perPage,
    sort: params.sort,
    dir: params.dir,
  })
  const packName = (key: string) => t(`setup.agents.packs.${key}.title`)
  return {
    title: t('setup.agents.activity.title'),
    description: t('setup.agents.activity.description'),
    docHref: '/docs/setup-agents-group',
    learnMore: t('setup.agents.overview.guideLink'),
    backHref: '/admin/setup/agents',
    backLabel: t('setup.agents.nav.overview'),
    filterLabel: t('setup.agents.activity.packColumn'),
    filterAll: t('setup.agents.activity.allPacks'),
    filterOptions: [...CONTINUOUS_CLOSE_AGENT_KEYS].map((key) => ({ value: key, label: packName(key) })),
    statusAll: t('setup.agents.activity.allStatuses'),
    statusOptions: [...AGENT_RUN_STATUSES].map((value) => ({
      value,
      label: t(`setup.agents.runStatuses.${value}`),
    })),
    sinceLabel: t('setup.agents.activity.sinceColumn'),
    sinceAll: t('setup.agents.activity.sinceAll'),
    sinceOptions: (Object.keys(FINDING_SINCE_WINDOWS) as FindingSince[]).map((value) => ({
      value,
      label: t(`setup.agents.activity.since.${value}`),
    })),
    currentParams: sp,
    colPack: t('setup.agents.activity.packColumn'),
    colTrigger: t('setup.agents.activity.triggerColumn'),
    colStatus: t('setup.agents.activity.statusColumn'),
    colStarted: t('setup.agents.activity.startedColumn'),
    colDuration: t('setup.agents.activity.durationColumn'),
    colDetected: t('setup.agents.activity.detectedColumn'),
    colResolved: t('setup.agents.activity.resolvedColumn'),
    colActions: t('setup.agents.activity.actionsColumn'),
    hasRows: result.runs.length > 0,
    empty: result.runs.length === 0,
    emptyTitle: t('setup.agents.activity.empty'),
    emptyDescription: t('setup.agents.activity.emptyHint'),
    sort: params.sort,
    dir: params.dir,
    total: result.total,
    currentPage: params.page,
    perPage: params.perPage,
    rows: result.runs.map((run) => {
      // Title-case runStatuses like every other status badge — not the
      // lowercase sentence copy the overview header line uses.
      const failedLabel = t(`setup.agents.runStatuses.${run.status}`)
      return {
        id: run.id,
        agentKey: run.agentKey,
        packName: packName(run.agentKey),
        triggerLabel: t(`setup.agents.activity.triggers.${run.trigger}`),
        statusLabel:
          run.status === 'failed' && run.errorCode ? `${failedLabel} · ${run.errorCode}` : failedLabel,
        statusVariant:
          run.status === 'completed'
            ? 'success'
            : run.status === 'failed'
              ? 'destructive'
              : run.status === 'skipped'
                ? 'secondary'
                : 'outline',
        startedLine: dateTime(run.startedAt),
        durationLine: formatDuration(run.durationMs),
        detected: run.detected,
        autoResolved: run.autoResolved,
        findingsHref: '/agents',
        findingsLabel: t('setup.agents.activity.viewFindings'),
      }
    }),
  }
}

const f = ref<AgentsActivityData>()
const item = field

export function agentsActivitySpec(data: AgentsActivityData): PageSpec {
  return page({
    route: '/admin/setup/agents/activity',
    // Same shell rule as the sibling pages: the setup workspace owns the
    // chrome.
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
              href: data.backHref,
              label: data.backLabel,
              variant: 'outline',
              size: 'sm',
            }),
          ]),
        ]),
        grid('flex flex-wrap items-center gap-2', [
          widgetBlock('filter-chips', {
            basePath: '/admin/setup/agents/activity',
            currentParams: data.currentParams,
            paramKey: 'agent',
            label: data.filterLabel,
            allLabel: data.filterAll,
            options: data.filterOptions,
          }),
          widgetBlock('filter-chips', {
            basePath: '/admin/setup/agents/activity',
            currentParams: data.currentParams,
            paramKey: 'status',
            label: data.colStatus,
            allLabel: data.statusAll,
            options: data.statusOptions,
          }),
          widgetBlock('filter-chips', {
            basePath: '/admin/setup/agents/activity',
            currentParams: data.currentParams,
            paramKey: 'since',
            label: data.sinceLabel,
            allLabel: data.sinceAll,
            options: data.sinceOptions,
          }),
        ]),
        {
          ...widgetBlock('empty-state', {
            title: data.emptyTitle,
            description: data.emptyDescription,
          }),
          when: f('empty'),
        },
        {
          ...grid('rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              sorting: { basePath: '/admin/setup/agents/activity', sort: f('sort'), dir: f('dir') },
              columns: [
                column(f('colPack'), text(item('packName')), { sort: 'pack', className: 'font-medium' }),
                column(f('colTrigger'), text(item('triggerLabel'))),
                column(f('colStatus'), badge(item('statusLabel'), { variant: item('statusVariant') }), {
                  sort: 'status',
                }),
                column(f('colStarted'), text(item('startedLine')), { sort: 'started' }),
                column(f('colDuration'), text(item('durationLine')), { align: 'right' }),
                column(f('colDetected'), number(item('detected')), { align: 'right' }),
                column(f('colResolved'), number(item('autoResolved')), { align: 'right' }),
                column(f('colActions'), widgetCell('agents-run-actions', {
                  agentKey: item('agentKey'),
                  findingsHref: item('findingsHref'),
                  findingsLabel: item('findingsLabel'),
                }), { srOnlyHeader: true }),
              ],
            }),
          ]),
          when: f('hasRows'),
        },
        {
          ...pagination({
            basePath: '/admin/setup/agents/activity',
            total: f('total'),
            page: f('currentPage'),
            perPage: f('perPage'),
            bare: true,
          }),
          when: f('hasRows'),
        },
      ]),
    ],
  })
}
