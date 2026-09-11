import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'

/**
 * Automation flows, split into a loader and a spec.
 *
 * The table is a `table` block with the `app` variant: unlike the org-users
 * page (which hand-rolls a plain `<table>`), this page renders the shared
 * `@openbooks/ui` Table primitives (`Table`/`TableHeader`/`TableRow`/
 * `TableHead`/`TableBody`/`TableCell`), and the `app` variant renders those
 * same components — verified class by class, not assumed. Three cells are
 * more than one element each (the name link, the run badge + timestamp pair,
 * the enable/delete row actions), so they live as small components in
 * ./sections, placed by the spec as widget cells.
 *
 * Query, permission and formatting logic below are verbatim from page.tsx.
 */

const BASE = '/admin/flows'

const RUN_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  completed: 'success',
  waiting: 'warning',
  failed: 'destructive',
  running: 'secondary',
  cancelled: 'outline',
}

export interface FlowListRow {
  id: string
  name: string
  href: string
  subjectKind: string
  subjectLabel: string
  nodeCount: string
  lastRunStatus: string | null
  lastRunVariant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
  lastRunAt: string | null
  neverRanLabel: string
  updatedAt: string
  enabled: boolean
  enabledLabel: string
  enabledVariant: 'success' | 'outline'
  rowActions: { id: string; name: string; enabled: boolean; updatedAt: string }
}

export interface FlowsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  subjectLabel: string
  subjectOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  columnFlow: string
  columnSubject: string
  columnNodes: string
  columnLastRun: string
  columnUpdated: string
  columnStatus: string
  rows: FlowListRow[]
  total: number
  currentPage: number
  perPage: number
}

export async function loadFlows(
  sp: Record<string, string | string[] | undefined>,
): Promise<FlowsData> {
  const authz = await requirePermission('flows.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin.flows')
  const tHub = await getTranslations('admin.hub')
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const subject = pickString(sp.subject)

  const where = sql`f.org_id = ${orgId}
    ${subject ? sql` and f.subject_kind = ${subject}` : sql``}
    ${params.q ? sql` and f.name ilike ${'%' + params.q + '%'}` : sql``}`

  const [flows, subjects, totalRow] = await Promise.all([
    (db.execute(sql`
      select f.id, f.name, f.subject_kind, f.enabled, ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
             jsonb_array_length(f.graph->'nodes') as node_count,
             lr.status as last_run_status, lr.started_at as last_run_at
        from flows f
        left join lateral (
          select status, started_at from flow_runs r
           where r.flow_id = f.id order by r.started_at desc limit 1
        ) lr on true
       where ${where}
       order by f.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    (db.execute(sql`
      select subject_kind, count(*) as n from flows f
       where f.org_id = ${orgId} group by 1 order by 1`)),
    db.execute(sql`select count(*) as n from flows f where ${where}`) as any,
  ])

  const subjectLabel = new Map(listFlowSubjectProfiles().map((p) => [p.subjectKind, p.label]))
  const total = Number(totalRow.rows[0].n)

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    subjectLabel: t('subjectFilter'),
    subjectOptions: subjects.rows.map((r: any) => ({
      value: r.subject_kind,
      label: subjectLabel.get(String(r.subject_kind)) ?? String(r.subject_kind),
      count: Number(r.n),
    })),
    currentParams: sp,
    isEmpty: total === 0 && !params.q && !subject,
    hasRows: !(total === 0 && !params.q && !subject),
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
    columnFlow: t('table.flow'),
    columnSubject: t('table.subject'),
    columnNodes: t('table.nodes'),
    columnLastRun: t('table.lastRun'),
    columnUpdated: t('table.updated'),
    columnStatus: t('table.status'),
    rows: flows.rows.map((f: any) => ({
      id: String(f.id),
      name: String(f.name),
      href: `/admin/flows/${f.id}`,
      subjectKind: String(f.subject_kind),
      subjectLabel: subjectLabel.get(String(f.subject_kind)) ?? String(f.subject_kind),
      nodeCount: String(f.node_count),
      lastRunStatus: f.last_run_status != null ? String(f.last_run_status) : null,
      lastRunVariant: RUN_BADGE[String(f.last_run_status)] ?? 'outline',
      lastRunAt: f.last_run_at ? dateTime(f.last_run_at) : null,
      neverRanLabel: t('neverRan'),
      updatedAt: dateTime(f.updated_at),
      enabled: Boolean(f.enabled),
      enabledLabel: f.enabled ? t('statusEnabled') : t('statusDisabled'),
      enabledVariant: (f.enabled ? 'success' : 'outline') as 'success' | 'outline',
      rowActions: {
        id: String(f.id),
        name: String(f.name),
        enabled: Boolean(f.enabled),
        updatedAt: String(f.updated_at),
      },
    })),
    total,
    currentPage: params.page,
    perPage: params.perPage,
  }
}

const f = ref<FlowsData>()
const item = field
const rootF = rootRef<FlowsData>()

export function flowsSpec(data: FlowsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [widget('new-flow', {})],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'subject',
          label: data.subjectLabel,
          options: data.subjectOptions,
        }),
      ]),
    ],
    body: [
      {
        // `workflow` is NOT in the empty-state widget's closed icon map yet
        // — until the coordinator adds it, the spec
        // path renders the empty state without the glyph. Icon and action
        // named, not carried, per the component-reference rule.
        ...widgetBlock('empty-state', {
          icon: 'workflow',
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: 'new-flow',
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          columns: [
            column(
              rootF('columnFlow'),
              widgetCell('flow-name-cell', {
                name: item('name'),
                href: item('href'),
              }),
            ),
            column(rootF('columnSubject'), badge(item('subjectLabel'), { variant: 'secondary' })),
            column(rootF('columnNodes'), text(item('nodeCount')), {
              align: 'right',
              className: 'tabular-nums',
            }),
            column(
              rootF('columnLastRun'),
              widgetCell('flow-last-run-cell', {
                status: item('lastRunStatus'),
                variant: item('lastRunVariant'),
                at: item('lastRunAt'),
                fallback: item('neverRanLabel'),
              }),
              { className: 'text-slate-500 dark:text-slate-400' },
            ),
            column(rootF('columnUpdated'), text(item('updatedAt')), {
              className: 'text-slate-500 tabular-nums dark:text-slate-400',
            }),
            column(
              rootF('columnStatus'),
              badge(item('enabledLabel'), { variant: item('enabledVariant') }),
            ),
            column(
              '',
              widgetCell('flow-row-actions', {
                id: item('id'),
                name: item('name'),
                enabled: item('enabled'),
                updatedAt: item('rowActions.updatedAt'),
              }),
              // No alignment at all: the native header is a bare <TableHead />
              // and its body cell carries no class either.
            ),
          ],
        }),
        when: f('hasRows'),
      },
      pagination({
        basePath: BASE,
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
      }),
    ],
  })
}
