import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
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
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { readableContinuousCloseAgents } from '../../../lib/continuous-close'
import type { ContinuousCloseWorkItem } from './WorkItemDrawer'

/**
 * Continuous close, split into a loader and a spec.
 *
 * The page this vocabulary had not met before: TWO independent lists on one
 * screen, selected by a tab. Two consequences, both settled here rather than
 * papered over:
 *
 *  - The reports pager drives `reportPage`, not `page`, so `pagination` grew a
 *    `pageParamKey`. Without it, paging the reports list would reset the
 *    findings list.
 *  - The narrative list renders its own `<section>` per entry inside a
 *    `divide-y` container, so `repeat` grew `unwrapped`. The wrapper div it
 *    would otherwise add is markup the native page does not have — and the
 *    only honest fix for "the spec renders an extra element" is to teach the
 *    spec not to.
 *
 * The tab itself is presence, not branching: each tab's blocks carry their own
 * `when`, and the loader decides which tab is active. No spec-level `if`.
 */

const SORT_COLUMNS = {
  detected: sql`w.last_detected_at`,
  severity: sql`case w.severity when 'critical' then 3 when 'warning' then 2 else 1 end`,
  materiality: sql`w.materiality`,
  status: sql`w.status`,
} as const

const SEVERITY_VARIANT = { info: 'secondary', warning: 'warning', critical: 'destructive' } as const
const STATUS_VARIANT = {
  open: 'warning',
  in_review: 'secondary',
  resolved: 'success',
  dismissed: 'outline',
} as const

type WorkItemRow = {
  id: string
  agent_key: 'accounting' | 'finance'
  finding_type: string
  severity: 'info' | 'warning' | 'critical'
  status: 'open' | 'in_review' | 'resolved' | 'dismissed'
  confidence: string
  materiality: string
  summary: Record<string, unknown>
  first_detected_at: string | Date
  last_detected_at: string | Date
}
type CountRow = { agent_key: string; status: string; severity: string; n: string | number }
type ReportRow = {
  id: string
  agent_key: string
  narrative: Record<string, unknown>
  finished_at: string | Date
}
type WorkItemDetailRow = WorkItemRow & {
  dismissal_reason: string | null
  rating: 'helpful' | 'not_helpful' | null
}
type EvidenceRow = {
  id: string
  kind: string
  source_type: string
  source_id: string
  data: Record<string, unknown> | null
}

export interface FindingRow {
  id: string
  title: string
  href: string
  summary: string
  agentLabel: string
  severityLabel: string
  severityVariant: (typeof SEVERITY_VARIANT)[keyof typeof SEVERITY_VARIANT]
  materiality: string
  statusLabel: string
  statusVariant: (typeof STATUS_VARIANT)[keyof typeof STATUS_VARIANT]
  detected: string
}

export interface NarrativeRow {
  id: string
  href: string
  narrative: Record<string, unknown>
  labels: { agent: string; fallbackTitle: string; generated: string; open: string }
}

export interface ContinuousCloseData {
  title: string
  description: string
  settingsLabel: string
  canManage: boolean
  tabsAriaLabel: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  onFindings: boolean
  onReports: boolean
  locale: string
  metrics: { key: string; label: string; value: number; tone?: string }[]
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  agentLabel: string
  statusLabel: string
  severityLabel: string
  agentOptions: { value: string; label: string; count: number }[]
  statusOptions: { value: string; label: string; count: number }[]
  severityOptions: { value: string; label: string; count: number }[]
  reportSearchPlaceholder: string
  reportAgentOptions: { value: string; label: string; count: number }[]
  reportsTitle: string
  reportsDescription: string
  reportsEmpty: string
  reportRows: NarrativeRow[]
  reportTotal: number
  reportPage: number
  reportPerPage: number
  findingsEmpty: boolean
  findingsPresent: boolean
  emptyTitle: string
  emptyDescription: string
  emptyAction: string
  emptyActionHref: string
  columnFinding: string
  columnAgent: string
  columnSeverity: string
  columnMateriality: string
  columnStatus: string
  columnDetected: string
  rows: FindingRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  itemDrawerOpen: boolean
  itemDrawer: {
    item: ContinuousCloseWorkItem
    closeHref: string
    canWrite: boolean
  } | null
  narrativeDrawerOpen: boolean
  narrativeDrawer: Record<string, unknown> | null
}

export async function loadContinuousClose(
  sp: Record<string, string | string[] | undefined>,
): Promise<ContinuousCloseData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const authz = await requirePermission('assistant.use')
  const readable = readableContinuousCloseAgents(authz)
  if (readable.length === 0) redirect('/assistant')
  const t = await getTranslations('continuousClose')
  const tc = await getTranslations('common')
  const locale = await getLocale()
  const tab = pickString(sp.tab) === 'reports' ? 'reports' : 'findings'
  const params = parseListParams(sp, {
    sort: 'detected',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['detected', 'severity', 'materiality', 'status'] as const,
  })
  const requestedAgent = pickString(sp.agent)
  const agent =
    requestedAgent === 'accounting' || requestedAgent === 'finance'
      ? readable.includes(requestedAgent)
        ? requestedAgent
        : undefined
      : undefined
  const requestedStatus = pickString(sp.status)
  const status = ['open', 'in_review', 'resolved', 'dismissed'].includes(requestedStatus ?? '')
    ? requestedStatus
    : undefined
  const requestedSeverity = pickString(sp.severity)
  const severity = ['info', 'warning', 'critical'].includes(requestedSeverity ?? '')
    ? requestedSeverity
    : undefined
  const reportQ = pickString(sp.reportQ)?.trim().slice(0, 200)
  const requestedReportAgent = pickString(sp.reportAgent)
  const reportAgent =
    requestedReportAgent === 'accounting' || requestedReportAgent === 'finance'
      ? readable.includes(requestedReportAgent)
        ? requestedReportAgent
        : undefined
      : undefined
  const reportPage = Math.min(
    1_000_000,
    Math.max(1, Number.parseInt(pickString(sp.reportPage) ?? '1', 10) || 1),
  )
  const reportPerPage = 5
  const readableSql = sql.raw(`(${readable.map((key) => `'${key}'`).join(',')})`)
  const base = sql`w.org_id = ${authz.user.orgId} and w.agent_key in ${readableSql}`
  const where = sql`${base}
    ${agent ? sql`and w.agent_key = ${agent}` : sql``}
    ${status ? sql`and w.status = ${status}` : sql``}
    ${severity ? sql`and w.severity = ${severity}` : sql``}
    ${params.q ? sql`and (w.finding_type ilike ${`%${params.q}%`} or w.summary::text ilike ${`%${params.q}%`})` : sql``}`

  const [rows, totalResult, counts, statusCounts, severityCounts] = await Promise.all([
    db.execute<WorkItemRow>(sql`
      select w.id, w.agent_key, w.finding_type, w.severity, w.status, w.confidence::text,
             w.materiality::text, w.summary, w.first_detected_at, w.last_detected_at
        from ai_work_items w where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`}, w.id
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute<Record<string, unknown>>(
      sql`select count(*) as n from ai_work_items w where ${where}`,
    ),
    db.execute<CountRow>(
      sql`select agent_key, count(*) as n from ai_work_items w where ${base} group by agent_key`,
    ),
    db.execute<CountRow>(
      sql`select status, count(*) as n from ai_work_items w where ${base} group by status`,
    ),
    db.execute<CountRow>(
      sql`select severity, count(*) as n from ai_work_items w where ${base} group by severity`,
    ),
  ])
  const total = Number(totalResult.rows[0]?.n ?? 0)
  const reportBase = sql`r.org_id = ${authz.user.orgId} and r.agent_key in ${readableSql}
    and r.status = 'completed' and jsonb_typeof(r.stats->'enrichment'->'narrative') = 'object'`
  const reportWhere = sql`${reportBase}
    ${reportAgent ? sql`and r.agent_key = ${reportAgent}` : sql``}
    ${
      reportQ
        ? sql`and (
      r.stats->'enrichment'->'narrative'->>'title' ilike ${`%${reportQ}%`}
      or r.stats->'enrichment'->'narrative'->>'executiveSummary' ilike ${`%${reportQ}%`}
      or r.stats->'enrichment'->'narrative'->>'periodLabel' ilike ${`%${reportQ}%`}
    )`
        : sql``
    }`
  const [reportRows, reportTotalResult, reportAgentCounts] = await Promise.all([
    db.execute<ReportRow>(sql`
      select r.id, r.agent_key, r.stats->'enrichment'->'narrative' as narrative, r.finished_at
        from ai_agent_runs r where ${reportWhere}
       order by r.finished_at desc, r.id desc
       limit ${reportPerPage} offset ${(reportPage - 1) * reportPerPage}
    `),
    db.execute<Record<string, unknown>>(
      sql`select count(*) as n from ai_agent_runs r where ${reportWhere}`,
    ),
    db.execute<CountRow>(
      sql`select r.agent_key, count(*) as n from ai_agent_runs r where ${reportBase} group by r.agent_key`,
    ),
  ])
  const reportTotal = Number(reportTotalResult.rows[0]?.n ?? 0)
  const itemId = pickString(sp.item)
  let selected: ContinuousCloseWorkItem | null = null
  if (itemId && isUuid(itemId)) {
    const detail = await db.execute<WorkItemDetailRow>(sql`
      select w.*, f.rating
        from ai_work_items w
        left join ai_work_item_feedback f on f.work_item_id = w.id and f.org_id = w.org_id and f.user_id = ${authz.user.id}
       where w.id = ${itemId} and w.org_id = ${authz.user.orgId} and w.agent_key in ${readableSql}
    `)
    const row = detail.rows[0]
    if (row) {
      const evidence = await db.execute<EvidenceRow>(sql`
        select id, kind, source_type, source_id, data
          from ai_work_item_evidence where work_item_id = ${itemId} and org_id = ${authz.user.orgId}
         order by created_at, id
      `)
      selected = {
        id: row.id,
        agentKey: row.agent_key,
        findingType: row.finding_type,
        severity: row.severity,
        status: row.status,
        confidence: row.confidence,
        materiality: row.materiality,
        summary: row.summary ?? {},
        firstDetectedAt: new Date(row.first_detected_at).toISOString(),
        lastDetectedAt: new Date(row.last_detected_at).toISOString(),
        dismissalReason: row.dismissal_reason,
        feedback: row.rating ?? null,
        evidence: evidence.rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          sourceType: e.source_type,
          sourceId: e.source_id,
          data: e.data ?? {},
        })),
      }
    }
  }

  const reportId = pickString(sp.report)
  let selectedNarrative: ReportRow | null = null
  if (reportId && isUuid(reportId)) {
    const detail = await db.execute<ReportRow>(sql`
      select id, agent_key, stats->'enrichment'->'narrative' as narrative, finished_at
        from ai_agent_runs
       where id = ${reportId} and org_id = ${authz.user.orgId} and agent_key in ${readableSql}
         and status = 'completed' and jsonb_typeof(stats->'enrichment'->'narrative') = 'object'
    `)
    selectedNarrative = detail.rows[0] ?? null
  }

  const closeHref = mergeHref('/continuous-close', sp, { item: undefined })
  const reportCloseHref = mergeHref('/continuous-close', sp, { report: undefined })
  const canManage = can(authz, 'admin.ai.manage')
  const canWrite = can(authz, 'assistant.write')
  const activeCount = statusCounts.rows
    .filter((row) => row.status === 'open' || row.status === 'in_review')
    .reduce((sum, row) => sum + Number(row.n), 0)
  const criticalCount = Number(severityCounts.rows.find((row) => row.severity === 'critical')?.n ?? 0)
  const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })

  /** The one-line description under a finding's title. */
  function summaryLabel(summary: Record<string, unknown>): string {
    if (summary.accountName)
      return [summary.accountNumber, summary.accountName].filter(Boolean).join(' · ')
    if (summary.scenarioName) return String(summary.scenarioName)
    if (summary.currentPeriod) return `${summary.currentPeriod} / ${summary.priorPeriod}`
    if (summary.count != null) return t('summary.records', { count: Number(summary.count) })
    return t('summary.review')
  }

  return {
    title: t('title'),
    description: t('description'),
    settingsLabel: t('actions.settings'),
    canManage,
    tabsAriaLabel: t('tabs.ariaLabel'),
    tabs: (['findings', 'reports'] as const).map((key) => ({
      key,
      href: mergeHref('/continuous-close', sp, {
        tab: key === 'findings' ? undefined : key,
        item: undefined,
        report: undefined,
      }),
      label: t(`tabs.${key}`),
      active: tab === key,
    })),
    onFindings: tab === 'findings',
    onReports: tab === 'reports',
    locale,
    metrics: [
      { key: 'active', label: t('metrics.active'), value: activeCount },
      {
        key: 'critical',
        label: t('metrics.critical'),
        value: criticalCount,
        ...(criticalCount > 0 ? { tone: 'text-red-600 dark:text-red-400' } : {}),
      },
      {
        key: 'accounting',
        label: t('metrics.accounting'),
        value: Number(counts.rows.find((row) => row.agent_key === 'accounting')?.n ?? 0),
      },
      {
        key: 'finance',
        label: t('metrics.finance'),
        value: Number(counts.rows.find((row) => row.agent_key === 'finance')?.n ?? 0),
      },
    ],
    searchPlaceholder: t('search'),
    currentParams: sp,
    agentLabel: t('filters.agent'),
    statusLabel: tc('labels.status'),
    severityLabel: t('filters.severity'),
    agentOptions: counts.rows.map((row) => ({
      value: row.agent_key,
      label: t(`agents.${row.agent_key}`),
      count: Number(row.n),
    })),
    statusOptions: statusCounts.rows.map((row) => ({
      value: row.status,
      label: t(`status.${row.status}`),
      count: Number(row.n),
    })),
    severityOptions: severityCounts.rows.map((row) => ({
      value: row.severity,
      label: t(`severity.${row.severity}`),
      count: Number(row.n),
    })),
    reportSearchPlaceholder: t('reports.search'),
    reportAgentOptions: reportAgentCounts.rows.map((row) => ({
      value: row.agent_key,
      label: t(`agents.${row.agent_key}`),
      count: Number(row.n),
    })),
    reportsTitle: t('reports.title'),
    reportsDescription: t('reports.description'),
    reportsEmpty: t('reports.empty'),
    reportRows: reportRows.rows.map((report) => ({
      id: String(report.id),
      href: mergeHref('/continuous-close', sp, { tab: 'reports', report: report.id }),
      narrative: report.narrative,
      labels: {
        agent: t('narrative.agent', { agent: t(`agents.${report.agent_key}`) }),
        fallbackTitle: t('narrative.title'),
        generated: t('narrative.generated', { date: dateTime.format(new Date(report.finished_at)) }),
        open: t('narrative.open'),
      },
    })),
    reportTotal,
    reportPage,
    reportPerPage,
    findingsEmpty: tab === 'findings' && total === 0,
    findingsPresent: tab === 'findings' && total > 0,
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
    emptyAction: t('empty.action'),
    emptyActionHref: '/admin/ai',
    columnFinding: t('table.finding'),
    columnAgent: t('table.agent'),
    columnSeverity: t('table.severity'),
    columnMateriality: t('table.materiality'),
    columnStatus: tc('labels.status'),
    columnDetected: t('table.detected'),
    rows: rows.rows.map((row) => ({
      id: String(row.id),
      title: t(`findings.${row.finding_type}.title`),
      href: mergeHref('/continuous-close', sp, { item: row.id }),
      summary: summaryLabel(row.summary),
      agentLabel: t(`agents.${row.agent_key}`),
      severityLabel: t(`severity.${row.severity}`),
      severityVariant: SEVERITY_VARIANT[row.severity as keyof typeof SEVERITY_VARIANT],
      materiality: formatMoney(row.materiality),
      statusLabel: t(`status.${row.status}`),
      statusVariant: STATUS_VARIANT[row.status as keyof typeof STATUS_VARIANT],
      detected: dateOnly.format(new Date(row.last_detected_at)),
    })),
    total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    itemDrawerOpen: Boolean(selected),
    itemDrawer: selected ? { item: selected, closeHref, canWrite } : null,
    narrativeDrawerOpen: Boolean(selectedNarrative),
    narrativeDrawer: selectedNarrative
      ? {
          runId: selectedNarrative.id,
          title:
            typeof selectedNarrative.narrative.title === 'string'
              ? selectedNarrative.narrative.title
              : t('narrative.title'),
          narrative: selectedNarrative.narrative,
          closeHref: reportCloseHref,
          labels: {
            agent: t('narrative.agent', { agent: t(`agents.${selectedNarrative.agent_key}`) }),
            generated: t('narrative.generated', {
              date: dateTime.format(new Date(selectedNarrative.finished_at)),
            }),
            executiveSummary: t('narrative.executiveSummary'),
            highlights: t('narrative.highlights'),
            risks: t('narrative.risks'),
            recommendations: t('narrative.recommendations'),
            downloadPdf: t('narrative.downloadPdf'),
            sources: t('narrative.sources'),
          },
        }
      : null,
  }
}

const f = ref<ContinuousCloseData>()
const item = field
const rootF = rootRef<ContinuousCloseData>()

export function continuousCloseSpec(data: ContinuousCloseData): PageSpec {
  return page({
    route: '/continuous-close',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'link-button',
            { href: '/admin/ai', label: data.settingsLabel, variant: 'outline', iconKey: 'settings' },
            f('canManage'),
          ),
        ],
      }),
      widgetBlock('tab-nav', { ariaLabel: data.tabsAriaLabel, tabs: data.tabs }),
      {
        ...grid(
          'grid grid-cols-2 gap-2 sm:grid-cols-4',
          data.metrics.map((metric) =>
            widgetBlock('metric-tile', {
              label: metric.label,
              value: metric.value,
              locale: data.locale,
              ...(metric.tone ? { tone: metric.tone } : {}),
            }),
          ),
        ),
        when: f('onFindings'),
      },
      {
        ...grid('flex flex-wrap items-center gap-2', [
          widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
          widgetBlock('filter-chips', {
            basePath: '/continuous-close',
            currentParams: data.currentParams,
            paramKey: 'agent',
            label: data.agentLabel,
            options: data.agentOptions,
          }),
          widgetBlock('filter-chips', {
            basePath: '/continuous-close',
            currentParams: data.currentParams,
            paramKey: 'status',
            label: data.statusLabel,
            options: data.statusOptions,
          }),
          widgetBlock('filter-chips', {
            basePath: '/continuous-close',
            currentParams: data.currentParams,
            paramKey: 'severity',
            label: data.severityLabel,
            options: data.severityOptions,
          }),
        ]),
        when: f('onFindings'),
      },
      {
        ...grid('flex flex-wrap items-center gap-2', [
          widgetBlock('search-input', {
            placeholder: data.reportSearchPlaceholder,
            paramKey: 'reportQ',
            pageParamKey: 'reportPage',
          }),
          widgetBlock('filter-chips', {
            basePath: '/continuous-close',
            currentParams: data.currentParams,
            paramKey: 'reportAgent',
            pageParamKey: 'reportPage',
            label: data.agentLabel,
            options: data.reportAgentOptions,
          }),
        ]),
        when: f('onReports'),
      },
    ],
    body: [
      {
        ...grid(
          'overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
          [
            widgetBlock('reports-card-heading', {
              title: data.reportsTitle,
              description: data.reportsDescription,
            }),
            repeat({
              items: f('reportRows'),
              itemKey: item('id'),
              className: 'divide-y divide-slate-200 px-3 dark:divide-slate-800',
              unwrapped: true,
              blocks: [
                widgetBlock('narrative-entry', {
                  narrative: item('narrative'),
                  href: item('href'),
                  labels: item('labels'),
                }),
              ],
              empty: {
                text: rootF('reportsEmpty'),
                className: 'px-4 py-6 text-center text-sm text-slate-500',
              },
            }),
            pagination({
              basePath: '/continuous-close',
              total: f('reportTotal'),
              page: f('reportPage'),
              perPage: f('reportPerPage'),
              pageParamKey: 'reportPage',
              bare: true,
            }),
          ],
          { as: 'section' },
        ),
        when: f('onReports'),
      },
      {
        ...widgetBlock('empty-state', {
          icon: 'activity',
          title: data.emptyTitle,
          description: data.emptyDescription,
          ...(data.canManage
            ? {
                action: 'link-button',
                actionProps: { href: data.emptyActionHref, label: data.emptyAction },
              }
            : {}),
        }),
        when: f('findingsEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/continuous-close', sort: f('sort'), dir: f('dir') },
          columns: [
            column(
              rootF('columnFinding'),
              widgetCell('finding-cell', {
                title: item('title'),
                href: item('href'),
                summary: item('summary'),
              }),
            ),
            column(rootF('columnAgent'), badge(item('agentLabel'), { variant: 'outline' })),
            column(
              rootF('columnSeverity'),
              badge(item('severityLabel'), { variant: item('severityVariant') }),
              { sort: 'severity' },
            ),
            column(rootF('columnMateriality'), money(item('materiality')), {
              sort: 'materiality',
              align: 'right',
              className: 'font-medium',
            }),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') }), {
              sort: 'status',
            }),
            column(rootF('columnDetected'), text(item('detected')), {
              sort: 'detected',
              className: 'text-sm text-slate-500',
            }),
          ],
        }),
        when: f('findingsPresent'),
      },
      {
        ...pagination({
          basePath: '/continuous-close',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
          bare: true,
        }),
        when: f('findingsPresent'),
      },
      { ...widgetBlock('work-item-drawer', { drawer: data.itemDrawer }), when: f('itemDrawerOpen') },
      {
        ...widgetBlock('narrative-drawer', { drawer: data.narrativeDrawer }),
        when: f('narrativeDrawerOpen'),
      },
    ],
  })
}
