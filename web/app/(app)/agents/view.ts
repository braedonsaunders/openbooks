import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  frame,
  grid,
  money,
  page,
  pageHeader,
  pagination,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'
import { dateTime } from '../../../lib/format'
import { parseAgentFindingsParams } from '../../../lib/list/agent-findings'
import { readableContinuousCloseAgents } from '../../../lib/continuous-close'
import { loadAgentInbox } from '../../../lib/agents/inbox'
import { loadBriefing } from '../../../lib/agents/briefing'
import { loadWorkItemDetail } from '../../../lib/agents/work-item'
import { listWorkItemNotes, loadWorkItemAssignment } from '../../../lib/agents/assignments'
import { listAgentNotificationTargets, listAgentRuns } from '../../../lib/setup/agents'
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
  age: string
  assigneeLabel: string
  due: string
  dueOverdueLabel: string
}

export interface AgentsTriageRow {
  id: string
  href: string
  hasProposal: boolean
  status: string
}

export interface AgentsData {
  title: string
  description: string
  configureLabel: string
  configureHref: string
  canManage: boolean
  /** Loader-formatted `Kpi[]` for the shared strip — counts in locale digits,
   *  last run as a relative instant. */
  kpis: { label: string; value: string; tone?: 'good' | 'bad' }[]
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  packLabel: string
  statusLabel: string
  severityLabel: string
  subsidiaryLabel: string
  subsidiaryHelp: string
  proposalLabel: string
  assignmentLabel: string
  sinceLabel: string
  sinceOptions: { value: string; label: string }[]
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
  columnAge: string
  columnAssignee: string
  columnDue: string
  rows: AgentsInboxRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
  tabs: { key: string; href: string; label: string; active: boolean }[]
  proposalsOnly: boolean
  briefingMode: boolean
  showInbox: boolean
  showProposals: boolean
  showBriefing: boolean
  showInboxChrome: boolean
  /** Briefing tab: heading + generated-at line for the section block, the
   *  cached markdown for the body widget, and the empty/action states. */
  briefingTitle: string
  briefingGeneratedAt: string | null
  briefingText: string | null
  hasBriefing: boolean
  briefingEmpty: boolean
  briefingEmptyTitle: string
  briefingActions: {
    aiEnabled: boolean
    hasBriefing: boolean
    generateLabel: string
    generatingLabel: string
    sendLabel: string
    sentLabel: string
    sendFailedLabel: string
    failedLabel: string
    errorLabels: Record<string, string>
  }
  inboxEmpty: boolean
  /** Localized keyboard-helper sentence for the paging row. */
  triageHint: string
  proposalsEmpty: boolean
  proposalsEmptyTitle: string
  proposalsEmptyDescription: string
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

/**
 * The model often repeats the section title as the markdown's own H1, which
 * would double the card heading. Strip that duplicated first line in the
 * loader (loader computes) so the heading + generated-at meta stay the
 * single title. Only an exact `# {title}` match strips — anything else is
 * the model's own structure and stays untouched.
 */
function stripBriefingTitle(text: string | null, title: string): string | null {
  if (!text) return null
  const newline = text.indexOf('\n')
  const first = (newline === -1 ? text : text.slice(0, newline)).trim()
  if (first !== `# ${title}`) return text
  return newline === -1 ? '' : text.slice(newline + 1).replace(/^\n+/, '')
}

/** Largest fitting unit, always in the past ("3 hours ago", never "in …"). */
function lastRunAgo(format: Intl.RelativeTimeFormat, startedAt: string): string {
  const minutes = Math.min(-1, Math.round((Date.parse(startedAt) - Date.now()) / 60_000))
  if (minutes > -60) return format.format(minutes, 'minute')
  const hours = Math.ceil(minutes / 60)
  if (hours > -48) return format.format(hours, 'hour')
  return format.format(Math.ceil(hours / 24), 'day')
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
  // The list source owns every list param: filters, rank/column sort, and
  // paging. Tab params (proposals/briefing/item) stay here — they switch
  // sections, not the list itself.
  const findings = parseAgentFindingsParams(sp)
  const params = { page: findings.page, perPage: findings.perPage }

  const proposalsOnly = singleParam(sp, 'proposals') === 'true'
  const briefingMode = singleParam(sp, 'briefing') === 'true'

  const [inbox, { runs }] = await Promise.all([
    loadAgentInbox(authz, {
      ...findings.filters,
      ...(briefingMode ? { limit: 1, offset: 0 } : {}),
      ...(proposalsOnly ? { hasProposal: true as const } : {}),
    }),
    // Freshness signal for the KPI strip — the Activity read model, reused
    // read-only. Never interpreted: only its start instant renders.
    listAgentRuns(authz.user.orgId, { limit: 1 }),
  ])

  const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const ageFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const countFormat = new Intl.NumberFormat(locale)
  const canWrite = can(authz, 'assistant.write')
  const activeCount = inbox.facets.statuses
    .filter((row) => row.key === 'open' || row.key === 'in_review')
    .reduce((sum, row) => sum + row.count, 0)
  const overdueCount = inbox.facets.overdue
  const lastRun = runs[0] ?? null

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

  // The proposals tab is the same list block filtered to carriers — no
  // second card renderer. Each row's drawer reuses the existing
  // WorkItemDrawer content, which already renders the governed review card
  // (or its unavailable note) from the viewer-signed command.
  return {
    title: t('title'),
    description: t('description'),
    configureLabel: t('configure'),
    configureHref: '/admin/setup/agents',
    canManage: can(authz, 'admin.setup.manage'),
    kpis: [
      { label: t('kpis.open'), value: countFormat.format(activeCount) },
      { label: t('kpis.proposals'), value: countFormat.format(inbox.facets.withProposals) },
      {
        label: t('kpis.overdue'),
        value: countFormat.format(overdueCount),
        ...(overdueCount > 0 ? { tone: 'bad' as const } : {}),
      },
      {
        label: t('kpis.lastRun'),
        value: lastRun ? lastRunAgo(ageFormat, lastRun.startedAt) : t('kpis.never'),
      },
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
    sinceLabel: t('facets.since'),
    sinceOptions: [
      { value: 'day', label: t('since.day') },
      { value: 'week', label: t('since.week') },
    ],
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
    columnAge: t('columns.age'),
    columnAssignee: t('facets.assignment'),
    columnDue: t('columns.due'),
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
      age: ageFormat.format(
        -Math.max(0, Math.round((Date.now() - new Date(row.lastDetectedAt).getTime()) / 86_400_000)),
        'day',
      ),
      assigneeLabel: row.assignee ? row.assignee.name : t('assignment.unassigned'),
      due: dateTime(row.dueAt),
      dueOverdueLabel: row.overdue ? t('facets.overdue') : '',
    })),
    total: inbox.total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: findings.sort,
    dir: findings.dir,
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
      // Runs live in Setup → Agents (c02); the tab links out, same as the
      // configure action. Never active here — the workbench owns no run UI.
      {
        key: 'activity',
        href: '/admin/setup/agents/activity',
        label: t('tabs.activity'),
        active: false,
      },
    ],
    proposalsOnly,
    briefingMode,
    showInbox: !proposalsOnly && !briefingMode,
    showProposals: proposalsOnly && !briefingMode,
    showBriefing: briefingMode,
    showInboxChrome: !briefingMode,
    briefingTitle: t('briefing.title'),
    briefingGeneratedAt: briefing.briefing
      ? t('briefing.generatedAt', {
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(briefing.briefing.generatedAt),
          ),
        })
      : null,
    briefingText: stripBriefingTitle(briefing.briefing?.text ?? null, t('briefing.title')),
    hasBriefing: briefing.briefing !== null,
    briefingEmpty: briefingMode && briefing.briefing === null,
    briefingEmptyTitle: briefing.aiEnabled ? t('briefing.empty') : t('briefing.noAi'),
    briefingActions: {
      aiEnabled: briefing.aiEnabled,
      hasBriefing: briefing.briefing !== null,
      generateLabel: t('briefing.generate'),
      generatingLabel: t('briefing.generating'),
      sendLabel: t('briefing.send'),
      sentLabel: t('briefing.sent'),
      sendFailedLabel: t('briefing.sendFailed'),
      failedLabel: t('briefing.errors.failed'),
      errorLabels: {
        failed: t('briefing.errors.failed'),
        ai_not_configured: t('briefing.errors.ai_not_configured'),
        briefing_empty: t('briefing.errors.briefing_empty'),
        briefing_failed: t('briefing.errors.briefing_failed'),
        no_briefing: t('briefing.errors.no_briefing'),
        invalid_action: t('briefing.errors.invalid_action'),
      },
    },
    inboxEmpty: !proposalsOnly && !briefingMode && inbox.total === 0,
    triageHint: t('triage.hint'),
    proposalsEmpty: proposalsOnly && !briefingMode && inbox.total === 0,
    proposalsEmptyTitle: t('lane.emptyTitle'),
    proposalsEmptyDescription: t('lane.emptyDescription'),
    findingsPresent: !briefingMode && inbox.total > 0,
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
          widget('module-home-tabs', { tabs: data.tabs }),
          widget(
            'link-button',
            { href: '/admin/setup/agents', label: data.configureLabel, variant: 'outline', iconKey: 'settings' },
            f('canManage'),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock('agents-triage-keys', {
          rows: data.triage.rows,
          canWrite: data.triage.canWrite,
          orgId: data.triage.orgId,
        }),
        when: f('showInboxChrome'),
      },
      {
        ...frame('card', [
          grid('space-y-4 p-6', [
            widgetBlock('section-heading', {
              id: 'agents-briefing-heading',
              title: data.briefingTitle,
              description: data.briefingGeneratedAt,
            }),
            widgetBlock('agents-briefing-body', { text: data.briefingText }),
            widgetBlock('agents-briefing-actions', { ...data.briefingActions }),
          ]),
        ]),
        when: f('hasBriefing'),
      },
      {
        ...widgetBlock('empty-state', {
          icon: 'send',
          title: data.briefingEmptyTitle,
        }),
        when: f('briefingEmpty'),
      },
      {
        ...widgetBlock('agents-briefing-actions', { ...data.briefingActions }),
        when: f('briefingEmpty'),
      },
      {
        ...widgetBlock('agents-kpi-strip', { items: data.kpis }),
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
        widgetBlock('filter-chips', {
          basePath: '/agents',
          currentParams: data.currentParams,
          paramKey: 'since',
          label: data.sinceLabel,
          options: data.sinceOptions,
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
        when: f('inboxEmpty'),
      },
      {
        ...widgetBlock('empty-state', {
          icon: 'activity',
          title: data.proposalsEmptyTitle,
          description: data.proposalsEmptyDescription,
        }),
        when: f('proposalsEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/agents', sort: f('sort'), dir: f('dir') },
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
            column(f('columnSeverity'), badge(item('severityLabel'), { variant: item('severityVariant') }), {
              sort: 'severity',
            }),
            column(f('columnMateriality'), money(item('materiality')), {
              align: 'right',
              className: 'font-medium',
              sort: 'materiality',
            }),
            column(f('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(
              f('columnProposal'),
              widgetCell('optional-badge', { label: item('proposalBadge'), variant: 'outline' }),
            ),
            column(f('columnAge'), text(item('age')), {
              className: 'text-sm text-slate-500',
            }),
            column(f('columnAssignee'), text(item('assigneeLabel')), {
              className: 'text-sm text-slate-500',
            }),
            column(
              f('columnDue'),
              widgetCell('agents-due-cell', { date: item('due'), overdueLabel: item('dueOverdueLabel') }),
              { className: 'text-sm text-slate-500' },
            ),
            column(f('columnDetected'), text(item('detected')), {
              className: 'text-sm text-slate-500',
              sort: 'detected',
            }),
          ],
        }),
        when: f('findingsPresent'),
      },
      {
        ...grid('mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2', [
          pagination({
            basePath: '/agents',
            total: f('total'),
            page: f('currentPage'),
            perPage: f('perPage'),
            bare: true,
          }),
          widgetBlock('agents-triage-hint', { text: data.triageHint }),
        ]),
        when: f('findingsPresent'),
      },
      { ...widgetBlock('work-item-drawer', { drawer: data.itemDrawer }), when: f('itemDrawerOpen') },
    ],
  })
}
