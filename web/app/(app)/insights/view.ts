import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { allowedSources, getSource } from '@openbooks/analytics'
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
import { can, requirePermission } from '../../../lib/authz'
import { featureEnabled, orgFeatureState } from '../../../lib/features'
import { buildListDrawerHref, isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { loadCard } from '../../api/insights/_lib'
import { VIZ_META } from './viz-meta'

/**
 * Insight cards, split into a loader and a spec.
 *
 * Sibling of the dashboards list and needed no new vocabulary. The only detail
 * worth noting: the chart column renders a per-visualization ICON COMPONENT
 * from VIZ_META. A component reference is exactly what a spec must never carry,
 * so the loader passes the viz type and its localized label and the lookup
 * happens inside the cell component.
 */

const SORT_COLUMNS = {
  name: sql`name`,
  updated: sql`updated_at`,
} as const

export interface CardRow {
  id: string
  name: string
  href: string
  description: string | null
  source: string
  vizType: string
  vizLabel: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
  updated: string
}

export interface InsightsData {
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
  columnSource: string
  columnChart: string
  columnStatus: string
  columnUpdated: string
  rows: CardRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  canCreate: boolean
  studioOpen: boolean
  studioProps: Record<string, unknown> | null
}

export async function loadInsights(
  sp: Record<string, string | string[] | undefined>,
): Promise<InsightsData> {
  const [t, tCommon, tCatalog] = await Promise.all([
    getTranslations('insights'),
    getTranslations('common'),
    getTranslations('reports'),
  ])
  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const canPublish = can(authz, 'insights.publish')
  const orgId = authz.user.orgId

  const cardId = typeof sp.card === 'string' ? sp.card : undefined
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

  const [cards, counts, features] = await Promise.all([
    db.execute(sql`
      select id, name, description, viz_type, status, query, updated_at
        from insight_cards
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ total: string; drafts: string; published: string }>(sql`
      select count(*) as total,
             count(*) filter (where status = 'draft') as drafts,
             count(*) filter (where status = 'published') as published
        from insight_cards where org_id = ${orgId} and ${visibility}`),
    orgFeatureState(orgId),
  ])
  const c = counts.rows[0]!
  const total = Number(c.total)
  const filteredTotal =
    params.q || status
      ? Number(
          (await db.execute<{ n: string }>(sql`select count(*) as n from insight_cards where ${where}`))
            .rows[0]!.n,
        )
      : total

  const openCard = cardId && cardId !== 'new' && isUuid(cardId) ? await loadCard(cardId, orgId) : null

  return {
    title: t('title'),
    description: t('cards.description'),
    searchPlaceholder: t('cards.searchPlaceholder'),
    statusLabel: tCommon('labels.status'),
    statusOptions: [
      { value: 'draft', label: tCommon('status.draft'), count: Number(c.drafts) },
      { value: 'published', label: t('status.published'), count: Number(c.published) },
    ],
    currentParams: sp,
    emptyTitle: t('cards.emptyTitle'),
    emptyDescription: t('cards.emptyDescription'),
    isEmpty: total === 0,
    hasRows: total > 0,
    columnName: tCommon('labels.name'),
    columnSource: t('cards.sourceColumn'),
    columnChart: t('cards.chartColumn'),
    columnStatus: tCommon('labels.status'),
    columnUpdated: tCommon('labels.updated'),
    rows: cards.rows.map((row) => {
      const query = row.query as { source?: string } | null
      const source = query?.source ? getSource(query.source) : undefined
      const viz = VIZ_META.find((v) => v.value === row.viz_type)
      return {
        id: String(row.id),
        name: String(row.name),
        href: buildListDrawerHref('/insights', sp, 'card', String(row.id)),
        description: (row.description as string | null) ?? null,
        source: source ? tCatalog(`catalog.entities.${source.key}.label`) : '—',
        vizType: String(row.viz_type),
        vizLabel: viz ? t(viz.labelKey) : String(row.viz_type),
        statusLabel: row.status === 'published' ? t('status.published') : tCommon('status.draft'),
        statusVariant: row.status === 'published' ? 'success' : 'outline',
        updated: new Date(String(row.updated_at)).toLocaleDateString(),
      }
    }),
    total: filteredTotal,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    canCreate,
    studioOpen: Boolean(openCard),
    studioProps: openCard
      ? {
          card: openCard,
          canCreate,
          canPublish,
          inventoryEnabled: featureEnabled(features, 'inventory'),
          sourceKeys: allowedSources(
            (permission) => can(authz, permission),
            (key) => featureEnabled(features, key),
          ).map((s) => s.key),
        }
      : null,
  }
}

const f = ref<InsightsData>()
const item = field
const rootF = rootRef<InsightsData>()

const MUTED = 'text-slate-500 dark:text-slate-400'

export function insightsSpec(data: InsightsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('new-card', {}, f('canCreate'))],
      }),
      widgetBlock('insights-tabs', { active: 'cards' }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/insights',
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
          action: data.canCreate ? 'new-card' : null,
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/insights', sort: f('sort'), dir: f('dir') },
          columns: [
            column(
              rootF('columnName'),
              widgetCell('card-name-cell', {
                name: item('name'),
                href: item('href'),
                description: item('description'),
              }),
              { sort: 'name', className: 'font-semibold' },
            ),
            column(rootF('columnSource'), text(item('source')), { className: MUTED }),
            column(
              rootF('columnChart'),
              widgetCell('viz-cell', { vizType: item('vizType'), label: item('vizLabel') }),
            ),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(rootF('columnUpdated'), text(item('updated')), { sort: 'updated', className: MUTED }),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: '/insights',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
      widgetBlock('card-studio', { studio: data.studioProps }, f('studioOpen')),
    ],
  })
}
