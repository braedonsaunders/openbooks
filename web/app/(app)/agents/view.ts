import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  type ContinuousCloseAgentKey,
} from '@openbooks/engine/src/continuous-close-config.ts'
import {
  badge,
  column,
  field,
  grid,
  money,
  page,
  pageHeader,
  pagination,
  ref,
  repeat,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { readableContinuousCloseAgents } from '../../../lib/continuous-close'
import { loadAgentInbox } from '../../../lib/agents/inbox'
import { loadBriefing, type CachedBriefing } from '../../../lib/agents/briefing'
import { loadWorkItemDetail } from '../../../lib/agents/work-item'
import { listWorkItemNotes, loadWorkItemAssignment } from '../../../lib/agents/assignments'
import { listAgentNotificationTargets } from '../../../lib/setup/agents'
import { findingProposalCommand, type FindingProposalCommand } from '../../../lib/agents/proposals'
import { findingSummaryLine } from '../../../lib/agents/summary'
import type {
  ContinuousCloseWorkItem,
  WorkItemAssigneeOptions,
  WorkItemAssignmentView,
  WorkItemNoteView,
} from '../continuous-close/WorkItemDrawer'

/**
 * The Agent Workbench home, split into a loader and a spec.
 *
 * One ranked inbox across every readable agent pack (the loadAgentInbox
 * resolver the JSON feed also serves, so the page and the triage client can
 * never disagree), facet filters in the existing filter-chips vocabulary, the
 * shared work-item drawer, and a small triage island for keyboard triage,
 * bulk actions, and the changed-since-last-visit banner. Ranks by
 * materiality × confidence × age — the order IS the triage.
 *
 * /continuous-close redirects here (except its reports tab, which stays until
 * the briefing moves it); ?item= deep links keep working because the drawer
 * opens from the same param.
 */

const SEVERITY_VARIANT = { info: 'secondary', warning: 'warning', critical: 'destructive' } as const
const STATUS_VARIANT = {
  open: 'warning',
  in_review: 'secondary',
  resolved: 'success',
  dismissed: 'outline',
} as const

export interface AgentsInboxRow {
  id: string
  title: string
  href: string
  summary: string
  packLabel: string
  severityLabel: string
  severityVariant: (typeof SEVERITY_VARIANT)[keyof typeof SEVERITY_VARIANT]
  materiality: string
  statusLabel: string
  statusVariant: (typeof STATUS_VARIANT)[keyof typeof STATUS_VARIANT]
  proposalBadge: string
  detected: string
  assigneeLabel: string
}

export interface AgentsTriageRow {
  id: string
  href: string
  hasProposal: boolean
  status: string
}

export interface AgentsLaneCard {
  id: string
  title: string
  href: string
  summary: string
  packLabel: string
  severityLabel: string
  severityVariant: (typeof SEVERITY_VARIANT)[keyof typeof SEVERITY_VARIANT]
  materiality: string
  detected: string
  proposal: FindingProposalCommand | null
  unavailableLabel: string
}

export interface AgentsData {
  title: string
  description: string
  configureLabel: string
  configureHref: string
  canManage: boolean
  locale: string
  metrics: { key: string; label: string; value: number; tone?: string }[]
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  packLabel: string
  statusLabel: string
  severityLabel: string
  subsidiaryLabel: string
  subsidiaryHelp: string
  proposalLabel: string
  assignmentLabel: string
  packOptions: { value: string; label: string; count: number }[]
  statusOptions: { value: string; label: string; count: number }[]
  severityOptions: { value: string; label: string; count: number }[]
  subsidiaryOptions: { value: string; label: string; count: number }[]
  proposalOptions: { value: string; label: string; count: number }[]
  assignmentOptions: { value: string; label: string; count: number }[]
  columnFinding: string
  columnPack: string
  columnSeverity: string
  columnMateriality: string
  columnStatus: string
  columnDetected: string
  columnProposal: string
  columnAssignee: string
  rows: AgentsInboxRow[]
  total: number
  currentPage: number
  perPage: number
  tabsAriaLabel: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  proposalsOnly: boolean
  briefingMode: boolean
  showInbox: boolean
  showLane: boolean
  showBriefing: boolean
  showInboxChrome: boolean
  briefing: { briefing: CachedBriefing | null; aiEnabled: boolean }
  lane: AgentsLaneCard[]
  laneEmpty: boolean
  laneEmptyTitle: string
  laneEmptyDescription: string
  findingsEmpty: boolean
  findingsPresent: boolean
  emptyTitle: string
  emptyDescription: string
  emptyAction: string
  triage: { rows: AgentsTriageRow[]; canWrite: boolean; orgId: string }
  itemDrawerOpen: boolean
  itemDrawer: {
    item: ContinuousCloseWorkItem
    closeHref: string
    canWrite: boolean
    proposal: FindingProposalCommand | null
    assignment: WorkItemAssignmentView | null
    notes: WorkItemNoteView[]
    assignees: WorkItemAssigneeOptions | null
  } | null
}

function singleParam(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = pickString(sp[key])
  return raw && raw.length > 0 ? raw : undefined
}

export async function loadAgents(
  sp: Record<string, string | string[] | undefined>,
): Promise<AgentsData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const authz = await requirePermission('assistant.use')
  const readable = readableContinuousCloseAgents(authz)
  const t = await getTranslations('agents')
  const tc = await getTranslations('continuousClose')
  const tcc = await getTranslations('common')
  const locale = await getLocale()
  const params = parseListParams(sp, {
    sort: 'detected',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['detected'] as const,
  })

  const requestedPacks = singleParam(sp, 'packs')
    ?.split(',')
    .map((s) => s.trim())
    .filter((s): s is ContinuousCloseAgentKey =>
      (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(s),
    )
  const severity = singleParam(sp, 'severity')
  const status = singleParam(sp, 'status')
  const subsidiary = singleParam(sp, 'subsidiary')
  const proposalsOnly = singleParam(sp, 'proposals') === 'true'
  const briefingMode = singleParam(sp, 'briefing') === 'true'
  const assignedFilter = singleParam(sp, 'assigned')

  const inbox = await loadAgentInbox(authz, {
    limit: briefingMode ? 1 : params.perPage,
    offset: briefingMode ? 0 : (params.page - 1) * params.perPage,
    ...(requestedPacks && requestedPacks.length > 0 ? { packs: requestedPacks } : {}),
    ...(severity === 'info' || severity === 'warning' || severity === 'critical'
      ? { severities: [severity] }
      : {}),
    ...(status === 'open' || status === 'in_review' || status === 'resolved' || status === 'dismissed'
      ? { statuses: [status] }
      : {}),
    ...(params.q ? { query: params.q } : {}),
    ...(proposalsOnly ? { hasProposal: true as const } : {}),
    ...(subsidiary && isUuid(subsidiary) ? { subsidiaryId: subsidiary } : {}),
    ...(assignedFilter === 'mine' ? { assignedToMe: true as const } : {}),
    ...(assignedFilter === 'unassigned' ? { unassignedOnly: true as const } : {}),
    ...(assignedFilter === 'overdue' ? { overdueOnly: true as const } : {}),
  })

  const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const canWrite = can(authz, 'assistant.write')
  const activeCount = inbox.facets.statuses
    .filter((row) => row.key === 'open' || row.key === 'in_review')
    .reduce((sum, row) => sum + row.count, 0)

  const itemId = singleParam(sp, 'item')
  let selected: ContinuousCloseWorkItem | null = null
  let selectedAssignment: WorkItemAssignmentView | null = null
  let selectedNotes: WorkItemNoteView[] = []
  if (itemId && isUuid(itemId)) {
    selected = await loadWorkItemDetail(authz.user.orgId, authz.user.id, itemId, readable)
    if (selected) {
      const [assignment, notes] = await Promise.all([
        loadWorkItemAssignment(authz, itemId),
        listWorkItemNotes(authz, itemId),
      ])
      selectedAssignment = assignment
      selectedNotes = notes
    }
  }
  // Owner/role candidates stay behind the write gate: readers see names, not
  // the org directory.
  let assigneeOptions: WorkItemAssigneeOptions | null = null
  if (selected && canWrite) {
    const targets = await listAgentNotificationTargets(authz.user.orgId)
    assigneeOptions = { users: targets.users, roles: targets.roles }
  }
  const closeHref = mergeHref('/agents', sp, { item: undefined })
  const briefing = briefingMode ? await loadBriefing(authz) : { briefing: null, aiEnabled: false }

  // Proposals lane: every carrier row resolves its viewer-signed command up
  // front, so Apply needs no drawer round-trip. Unresolvable carriers stay
  // visible with an unavailable note — never a dead Apply.
  const lane: AgentsLaneCard[] = proposalsOnly
    ? inbox.rows.map((row) => ({
        id: row.id,
        title: tc(`findings.${row.findingType}.title`),
        href: mergeHref('/agents', sp, { item: row.id }),
        summary: findingSummaryLine((key, values) => tc(key, values as never), row.summary),
        packLabel: tc(`agents.${row.pack}`),
        severityLabel: tc(`severity.${row.severity}`),
        severityVariant: SEVERITY_VARIANT[row.severity],
        materiality: formatMoney(row.materiality),
        detected: dateOnly.format(new Date(row.lastDetectedAt)),
        proposal: canWrite ? findingProposalCommand(authz, row.summary) : null,
        unavailableLabel: t('lane.unavailable'),
      }))
    : []

  return {
    title: t('title'),
    description: t('description'),
    configureLabel: t('configure'),
    configureHref: '/admin/setup/agents',
    canManage: can(authz, 'admin.setup.manage'),
    locale,
    metrics: [
      { key: 'active', label: tc('metrics.active'), value: activeCount },
      {
        key: 'critical',
        label: tc('metrics.critical'),
        value: inbox.facets.severities.find((row) => row.key === 'critical')?.count ?? 0,
        ...((inbox.facets.severities.find((row) => row.key === 'critical')?.count ?? 0) > 0
          ? { tone: 'text-red-600 dark:text-red-400' }
          : {}),
      },
      { key: 'proposals', label: t('facets.proposal'), value: inbox.facets.withProposals },
    ],
    searchPlaceholder: t('search'),
    currentParams: sp,
    packLabel: t('facets.pack'),
    statusLabel: tcc('labels.status'),
    severityLabel: t('facets.severity'),
    subsidiaryLabel: t('facets.subsidiary'),
    subsidiaryHelp: t('subsidiaryHelp'),
    proposalLabel: t('facets.proposal'),
    assignmentLabel: t('facets.assignment'),
    packOptions: inbox.facets.packs.map((row) => ({
      value: row.key,
      label: tc(`agents.${row.key}`),
      count: row.count,
    })),
    statusOptions: inbox.facets.statuses.map((row) => ({
      value: row.key,
      label: tc(`status.${row.key}`),
      count: row.count,
    })),
    severityOptions: inbox.facets.severities.map((row) => ({
      value: row.key,
      label: tc(`severity.${row.key}`),
      count: row.count,
    })),
    subsidiaryOptions: inbox.facets.subsidiaries.map((row) => ({
      value: row.id,
      label: row.name,
      count: row.count,
    })),
    proposalOptions: [
      { value: 'true', label: t('facets.withProposal'), count: inbox.facets.withProposals },
    ],
    assignmentOptions: [
      { value: 'mine', label: t('facets.assignedToMe'), count: inbox.facets.assignedToMe },
      { value: 'unassigned', label: t('facets.unassigned'), count: inbox.facets.unassigned },
      { value: 'overdue', label: t('facets.overdue'), count: inbox.facets.overdue },
    ],
    columnFinding: tc('table.finding'),
    columnPack: t('facets.pack'),
    columnSeverity: tc('table.severity'),
    columnMateriality: tc('table.materiality'),
    columnStatus: tcc('labels.status'),
    columnDetected: tc('table.detected'),
    columnProposal: t('proposal.badge'),
    columnAssignee: t('facets.assignment'),
    rows: inbox.rows.map((row) => ({
      id: row.id,
      title: tc(`findings.${row.findingType}.title`),
      href: mergeHref('/agents', sp, { item: row.id }),
      summary: findingSummaryLine((key, values) => tc(key, values as never), row.summary),
      packLabel: tc(`agents.${row.pack}`),
      severityLabel: tc(`severity.${row.severity}`),
      severityVariant: SEVERITY_VARIANT[row.severity],
      materiality: formatMoney(row.materiality),
      statusLabel: tc(`status.${row.status}`),
      statusVariant: STATUS_VARIANT[row.status],
      proposalBadge: row.hasProposal ? t('proposal.badge') : '',
      detected: dateOnly.format(new Date(row.lastDetectedAt)),
      assigneeLabel: row.assignee
        ? row.dueAt
          ? `${row.assignee.name} · ${row.overdue ? t('facets.overdue') : dateOnly.format(new Date(row.dueAt))}`
          : row.assignee.name
        : t('assignment.unassigned'),
    })),
    total: inbox.total,
    currentPage: params.page,
    perPage: params.perPage,
    tabsAriaLabel: t('tabs.ariaLabel'),
    tabs: [
      {
        key: 'inbox',
        href: mergeHref('/agents', sp, { proposals: undefined, briefing: undefined, item: undefined }),
        label: t('tabs.inbox'),
        active: !proposalsOnly && !briefingMode,
      },
      {
        key: 'proposals',
        href: mergeHref('/agents', sp, { proposals: 'true', briefing: undefined, item: undefined }),
        label: t('tabs.proposals'),
        active: proposalsOnly && !briefingMode,
      },
      {
        key: 'briefing',
        href: mergeHref('/agents', sp, { proposals: undefined, briefing: 'true', item: undefined }),
        label: t('tabs.briefing'),
        active: briefingMode,
      },
    ],
    proposalsOnly,
    briefingMode,
    showInbox: !proposalsOnly && !briefingMode,
    showLane: proposalsOnly && !briefingMode,
    showBriefing: briefingMode,
    showInboxChrome: !briefingMode,
    briefing: { briefing: briefing.briefing, aiEnabled: briefing.aiEnabled },
    lane,
    laneEmpty: proposalsOnly && !briefingMode && inbox.total === 0,
    laneEmptyTitle: t('lane.emptyTitle'),
    laneEmptyDescription: t('lane.emptyDescription'),
    findingsEmpty: !proposalsOnly && !briefingMode && inbox.total === 0,
    findingsPresent: !proposalsOnly && !briefingMode && inbox.total > 0,
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
    emptyAction: t('empty.action'),
    triage: {
      rows: inbox.rows.map((row) => ({
        id: row.id,
        href: mergeHref('/agents', sp, { item: row.id }),
        hasProposal: row.hasProposal,
        status: row.status,
      })),
      canWrite,
      orgId: authz.user.orgId,
    },
    itemDrawerOpen: Boolean(selected),
    itemDrawer: selected
      ? {
          item: selected,
          closeHref,
          canWrite,
          proposal: canWrite ? findingProposalCommand(authz, selected.summary) : null,
          assignment: selectedAssignment,
          notes: selectedNotes,
          assignees: assigneeOptions,
        }
      : null,
  }
}

const f = ref<AgentsData>()
const item = field

export function agentsSpec(data: AgentsData): PageSpec {
  return page({
    route: '/agents',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'link-button',
            { href: '/admin/setup/agents', label: data.configureLabel, variant: 'outline', iconKey: 'settings' },
            f('canManage'),
          ),
        ],
      }),
    ],
    body: [
      widgetBlock('tab-nav', { ariaLabel: data.tabsAriaLabel, tabs: data.tabs }),
      {
        ...widgetBlock('agents-triage', {
          rows: data.triage.rows,
          canWrite: data.triage.canWrite,
          orgId: data.triage.orgId,
        }),
        when: f('showInboxChrome'),
      },
      {
        ...widgetBlock('agents-briefing', {
          briefing: data.briefing.briefing,
          aiEnabled: data.briefing.aiEnabled,
        }),
        when: f('showBriefing'),
      },
      {
        ...grid(
          'grid grid-cols-2 gap-2 sm:grid-cols-3',
          data.metrics.map((metric) =>
            widgetBlock('metric-tile', {
              label: metric.label,
              value: metric.value,
              locale: data.locale,
              ...(metric.tone ? { tone: metric.tone } : {}),
            }),
          ),
        ),
        when: f('showInboxChrome'),
      },
      {
        ...grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'packs',
          label: data.packLabel,
          options: data.packOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'severity',
          label: data.severityLabel,
          options: data.severityOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'subsidiary',
          label: data.subsidiaryLabel,
          options: data.subsidiaryOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'proposals',
          label: data.proposalLabel,
          options: data.proposalOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'assigned',
          label: data.assignmentLabel,
          options: data.assignmentOptions,
        }),
        ]),
        when: f('showInboxChrome'),
      },
      {
        ...widgetBlock('empty-state', {
          icon: 'activity',
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('findingsEmpty'),
      },
      {
        ...widgetBlock('empty-state', {
          icon: 'activity',
          title: data.laneEmptyTitle,
          description: data.laneEmptyDescription,
        }),
        when: f('laneEmpty'),
      },
      {
        ...repeat({
          items: f('lane'),
          itemKey: item('id'),
          className: 'space-y-3',
          blocks: [
            widgetBlock('proposal-lane-card', {
              title: item('title'),
              href: item('href'),
              summary: item('summary'),
              packLabel: item('packLabel'),
              severityLabel: item('severityLabel'),
              severityVariant: item('severityVariant'),
              materiality: item('materiality'),
              detected: item('detected'),
              proposal: item('proposal'),
              unavailableLabel: item('unavailableLabel'),
            }),
          ],
        }),
        when: f('showLane'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          columns: [
            column(
              f('columnFinding'),
              widgetCell('finding-cell', {
                title: item('title'),
                href: item('href'),
                summary: item('summary'),
              }),
            ),
            column(f('columnPack'), badge(item('packLabel'), { variant: 'outline' })),
            column(f('columnSeverity'), badge(item('severityLabel'), { variant: item('severityVariant') })),
            column(f('columnMateriality'), money(item('materiality')), {
              align: 'right',
              className: 'font-medium',
            }),
            column(f('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(f('columnProposal'), text(item('proposalBadge'))),
            column(f('columnAssignee'), text(item('assigneeLabel')), {
              className: 'text-sm text-slate-500',
            }),
            column(f('columnDetected'), text(item('detected')), {
              className: 'text-sm text-slate-500',
            }),
          ],
        }),
        when: f('findingsPresent'),
      },
      {
        ...pagination({
          basePath: '/agents',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
          bare: true,
        }),
        when: f('findingsPresent'),
      },
      { ...widgetBlock('work-item-drawer', { drawer: data.itemDrawer }), when: f('itemDrawerOpen') },
    ],
  })
}
