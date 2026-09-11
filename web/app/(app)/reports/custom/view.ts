import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
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
import { REPORT_ENTITY_MAP, type ReportCustomQuery } from '@openbooks/reports'
import { requirePermission } from '../../../../lib/authz'
import { hiddenReportEntityKeys, hiddenReportStatementKinds } from '../../../../lib/report-authz'
import { parseListParams, pickString } from '../../../../lib/list-params'

/**
 * The report catalog, split into a loader and a spec. No new vocabulary.
 *
 * The visibility filtering is the part that must never move into a spec. Denied
 * entities and statement kinds are excluded IN SQL — applied to the list AND to
 * the kind counts, because a count is a disclosure too, and a total that
 * includes reports the reader cannot see makes the empty state and the
 * pagination lie about what is there.
 */

const SORT_COLUMNS = {
  name: sql`name`,
  kind: sql`kind`,
  updated: sql`updated_at`,
} as const

const KIND_VARIANT: Record<string, 'secondary' | 'outline'> = {
  built_in: 'secondary',
  custom: 'outline',
}

export interface ReportDefRow {
  id: string
  name: string
  href: string
  summary: string
  description: string
  kindLabel: string
  kindVariant: 'secondary' | 'outline'
  updated: string
  kind: string
}

export interface CustomReportsData {
  title: string
  description: string
  searchPlaceholder: string
  kindFilterLabel: string
  kindOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  columnName: string
  columnDescription: string
  columnKind: string
  columnUpdated: string
  columnActions: string
  rows: ReportDefRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  canCreate: boolean
}

export async function loadCustomReports(
  sp: Record<string, string | string[] | undefined>,
): Promise<CustomReportsData> {
  const t = await getTranslations('reports.custom')
  const tc = await getTranslations('common')
  const tReports = await getTranslations('reports')
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'kind', 'updated'] as const,
  })
  const kind = pickString(sp.kind)

  /** One-line human summary of what a plan does, for the list. Entity labels
   *  resolve through the reports.catalog.* message catalog at render time. */
  function summarizePlan(query: ReportCustomQuery | null): string {
    // Statement definitions intentionally store their governed statement plan
    // in `statement`, not the entity-query column used by custom reports.
    if (!query) return t('kind.builtIn')
    const entity = REPORT_ENTITY_MAP[query.entity]
    const source = entity ? tReports(`catalog.entities.${entity.key}.label`) : query.entity
    if (query.mode === 'summarize') {
      return t('list.summarySummarize', {
        source,
        groups: (query.breakouts ?? []).length,
        measures: (query.measures ?? []).length || 1,
      })
    }
    return t('list.summaryRows', { source, columns: (query.columns ?? []).length })
  }

  /** Built-in definitions localize by slug; custom slugs fall back to stored text. */
  function definitionName(d: { kind: string; slug: string; name: string }): string {
    return d.kind === 'built_in' && tReports.has(`builtIns.${d.slug}.name`)
      ? tReports(`builtIns.${d.slug}.name`)
      : d.name
  }
  function definitionDescription(d: {
    kind: string
    slug: string
    description: string | null
  }): string | null {
    return d.kind === 'built_in' && tReports.has(`builtIns.${d.slug}.description`)
      ? tReports(`builtIns.${d.slug}.description`)
      : d.description
  }

  // Entities / statement kinds this reader may not run. The catalog page lists
  // names, slugs and the stored PLAN, so an unfiltered list leaks the shape of
  // payroll reporting — and the ids every execution path keys on — to anyone
  // holding reports.read, and leaks optional-module reports when the Features
  // switch is off. Filtered in SQL rather than after the fact so the kind
  // counts and the pagination totals describe what is actually shown.
  const [deniedEntities, deniedStatementKinds] = await Promise.all([
    hiddenReportEntityKeys(authz),
    hiddenReportStatementKinds(authz),
  ])

  const visibleEntity =
    deniedEntities.length > 0
      ? sql` and (query is null or coalesce(query->>'entity', '') <> all(${`{${deniedEntities.join(',')}}`}::text[]))`
      : sql``
  const visibleStatement =
    deniedStatementKinds.length > 0
      ? sql` and (statement is null or coalesce(statement->>'kind', '') <> all(${`{${deniedStatementKinds.join(',')}}`}::text[]))`
      : sql``
  const visible = sql`${visibleEntity}${visibleStatement}`

  const where = sql`org_id = ${authz.user.orgId}${visible}
    ${kind && kind !== 'all' ? sql` and kind = ${kind}` : sql``}
    ${params.q ? sql` and (name ilike ${'%' + params.q + '%'} or description ilike ${'%' + params.q + '%'})` : sql``}`

  const [defs, counts, filtered] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select id, kind, slug, name, description, query, updated_at
        from report_definitions
       where ${where}
       -- id is the tiebreaker, and it is not cosmetic. Sorting by kind
       -- alone leaves every row sharing a kind in an order Postgres may pick
       -- freshly per query — including BETWEEN the pages of this very
       -- limit/offset pagination, so a report could show up on page two after
       -- you already saw it on page one, or never show up at all. The
       -- conformance harness caught it as two runs disagreeing about which
       -- report came first.
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, id asc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ kind: string; n: string }>(sql`
      select kind, count(*) as n from report_definitions
       where org_id = ${authz.user.orgId}${visible} group by kind`),
    db.execute<{ n: string }>(sql`select count(*) as n from report_definitions where ${where}`),
  ])

  const total = counts.rows.reduce((a, r) => a + Number(r.n), 0)

  return {
    title: t('list.title'),
    description: t('list.description'),
    searchPlaceholder: t('list.searchPlaceholder'),
    kindFilterLabel: t('list.kindFilterLabel'),
    kindOptions: counts.rows.map((r) => ({
      value: r.kind,
      label: r.kind === 'built_in' ? t('kind.builtIn') : t('kind.custom'),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    isEmpty: total === 0,
    hasRows: total > 0,
    columnName: t('list.columns.report'),
    columnDescription: tc('labels.description'),
    columnKind: t('list.columns.kind'),
    columnUpdated: tc('labels.updated'),
    columnActions: tc('labels.actions'),
    rows: defs.rows.map((d) => {
      const row = d as { id: string; kind: string; slug: string; name: string; description: string | null }
      return {
        id: String(d.id),
        kind: row.kind,
        name: definitionName(row),
        href: `/reports/custom/run/${d.id}`,
        summary: summarizePlan(d.query as ReportCustomQuery | null),
        description: definitionDescription(row) ?? '—',
        kindLabel: row.kind === 'built_in' ? t('kind.builtIn') : t('kind.custom'),
        kindVariant: KIND_VARIANT[row.kind] ?? 'outline',
        updated: String(d.updated_at).slice(0, 10),
      }
    }),
    total: Number(filtered.rows[0]?.n ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    canCreate,
  }
}

const f = ref<CustomReportsData>()
const item = field
const rootF = rootRef<CustomReportsData>()

export function customReportsSpec(data: CustomReportsData): PageSpec {
  return page({
    route: '/reports/custom',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('new-report', {}, f('canCreate'))],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/reports/custom',
          currentParams: data.currentParams,
          paramKey: 'kind',
          label: data.kindFilterLabel,
          options: data.kindOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: data.canCreate ? 'new-report' : null,
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/reports/custom', sort: f('sort'), dir: f('dir') },
          columns: [
            column(
              rootF('columnName'),
              widgetCell('report-name-cell', {
                name: item('name'),
                href: item('href'),
                summary: item('summary'),
              }),
              { sort: 'name' },
            ),
            column(rootF('columnDescription'), text(item('description')), {
              className: 'max-w-md text-sm text-slate-600 dark:text-slate-300',
            }),
            column(rootF('columnKind'), badge(item('kindLabel'), { variant: item('kindVariant') }), {
              sort: 'kind',
            }),
            column(rootF('columnUpdated'), text(item('updated')), {
              sort: 'updated',
              className: 'text-sm text-slate-500 tabular-nums dark:text-slate-400',
            }),
            column(
              rootF('columnActions'),
              widgetCell('custom-report-actions', {
                id: item('id'),
                kind: item('kind'),
                canCreate: rootF('canCreate'),
              }),
              { align: 'right' },
            ),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: '/reports/custom',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
    ],
  })
}
