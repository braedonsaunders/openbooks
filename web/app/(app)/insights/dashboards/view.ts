import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
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
import { insightVisibilitySql } from '@/lib/insight-access'
import { can, requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'

/**
 * Insight dashboards, split into a loader and a spec.
 *
 * The first conversion with SORTABLE column headers. Two of its four columns
 * sort, so the table block gained a `sorting` config supplying the shared
 * inputs and each column opts in with a sort key. That renders the same
 * SortTh the native lists use rather than approximating it — sortable headers
 * appear on roughly 39 pages, which is far too many to leave to per-page
 * widgets.
 */

const SORT_COLUMNS = {
  name: sql`name`,
  updated: sql`updated_at`,
} as const

export interface DashboardRow {
  id: string
  name: string
  href: string
  description: string | null
  cardCount: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
  updated: string
}

export interface DashboardsData {
  title: string
  description: string
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  columnName: string
  columnCards: string
  columnStatus: string
  columnUpdated: string
  rows: DashboardRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  canCreate: boolean
}

export async function loadDashboards(
  sp: Record<string, string | string[] | undefined>,
): Promise<DashboardsData> {
  const [t, tCommon] = await Promise.all([getTranslations('insights'), getTranslations('common')])
  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const orgId = authz.user.orgId

  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['name', 'updated'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam === 'draft' || statusParam === 'published' ? statusParam : undefined

  const visibility = insightVisibilitySql(authz)
  const where = sql`org_id = ${orgId} and ${visibility}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}
    ${status ? sql` and status = ${status}` : sql``}`

  const [dashboards, counts] = await Promise.all([
    db.execute(sql`
      select id, name, description, status, updated_at,
             jsonb_array_length(layout) as card_count
        from insight_dashboards
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ total: string; drafts: string; published: string }>(sql`
      select count(*) as total,
             count(*) filter (where status = 'draft') as drafts,
             count(*) filter (where status = 'published') as published
        from insight_dashboards where org_id = ${orgId} and ${visibility}`),
  ])
  const c = counts.rows[0]!
  const total = Number(c.total)
  const filteredTotal =
    params.q || status
      ? Number(
          (
            await db.execute<{ n: string }>(
              sql`select count(*) as n from insight_dashboards where ${where}`,
            )
          ).rows[0]!.n,
        )
      : total

  return {
    title: t('title'),
    description: t('dashboards.description'),
    searchPlaceholder: t('dashboards.searchPlaceholder'),
    statusLabel: tCommon('labels.status'),
    statusOptions: [
      { value: 'draft', label: tCommon('status.draft'), count: Number(c.drafts) },
      { value: 'published', label: t('status.published'), count: Number(c.published) },
    ],
    currentParams: sp,
    emptyTitle: t('dashboards.emptyTitle'),
    emptyDescription: t('dashboards.emptyDescription'),
    isEmpty: total === 0,
    hasRows: total > 0,
    columnName: tCommon('labels.name'),
    columnCards: t('dashboards.cardsColumn'),
    columnStatus: tCommon('labels.status'),
    columnUpdated: tCommon('labels.updated'),
    rows: dashboards.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      href: `/insights/dashboards/${row.id}`,
      description: (row.description as string | null) ?? null,
      cardCount: String(Number(row.card_count)),
      statusLabel: row.status === 'published' ? t('status.published') : tCommon('status.draft'),
      statusVariant: row.status === 'published' ? 'success' : 'outline',
      updated: new Date(String(row.updated_at)).toLocaleDateString(),
    })),
    total: filteredTotal,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    canCreate,
  }
}

const f = ref<DashboardsData>()
const item = field
const rootF = rootRef<DashboardsData>()

const MUTED = 'text-slate-500 dark:text-slate-400'

export function dashboardsSpec(data: DashboardsData): PageSpec {
  return page({
    route: '/insights/dashboards',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('new-dashboard', {}, f('canCreate'))],
      }),
      widgetBlock('insights-tabs', { active: 'dashboards' }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/insights/dashboards',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: data.canCreate ? 'new-dashboard' : null,
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/insights/dashboards', sort: f('sort'), dir: f('dir') },
          columns: [
            column(
              rootF('columnName'),
              widgetCell('dashboard-name-cell', {
                name: item('name'),
                href: item('href'),
                description: item('description'),
              }),
              { sort: 'name', className: 'font-semibold' },
            ),
            column(rootF('columnCards'), text(item('cardCount')), { className: MUTED }),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(rootF('columnUpdated'), text(item('updated')), { sort: 'updated', className: MUTED }),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: '/insights/dashboards',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
    ],
  })
}
