import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { REPORT_ENTITY_MAP, type ReportCustomQuery } from '@openbooks/reports'
import { requirePermission } from '../../../../lib/authz'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { NewReportButton } from './NewReportButton'
import { CustomReportActions } from './CustomReportActions'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`name`,
  kind: sql`kind`,
  updated: sql`updated_at`,
} as const

const KIND_VARIANT: Record<string, 'secondary' | 'outline'> = {
  built_in: 'secondary',
  custom: 'outline',
}

export default async function CustomReports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('reports.custom')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'kind', 'updated'] as const,
  })
  const kind = pickString(sp.kind)

  /** One-line human summary of what a plan does, for the list. Entity labels
   *  come from packages/reports (server-defined constants) and render verbatim. */
  function summarizePlan(query: ReportCustomQuery): string {
    const entity = REPORT_ENTITY_MAP[query.entity]
    const source = entity?.label ?? query.entity
    if (query.mode === 'summarize') {
      return t('list.summarySummarize', {
        source,
        groups: (query.breakouts ?? []).length,
        measures: (query.measures ?? []).length || 1,
      })
    }
    return t('list.summaryRows', { source, columns: (query.columns ?? []).length })
  }

  const where = sql`org_id = ${authz.user.orgId}
    ${kind && kind !== 'all' ? sql` and kind = ${kind}` : sql``}
    ${params.q ? sql` and (name ilike ${'%' + params.q + '%'} or description ilike ${'%' + params.q + '%'})` : sql``}`

  const [defs, counts, filtered] = await Promise.all([
    db.execute(sql`
      select id, kind, slug, name, description, query, updated_at
        from report_definitions
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select kind, count(*) as n from report_definitions
       where org_id = ${authz.user.orgId} group by kind
    `) as unknown as Promise<{ rows: { kind: string; n: string }[] }>,
    db.execute(sql`select count(*) as n from report_definitions where ${where}`) as unknown as Promise<{
      rows: { n: string }[]
    }>,
  ])

  const total = counts.rows.reduce((a, r) => a + Number(r.n), 0)
  const filteredTotal = Number(filtered.rows[0]?.n ?? 0)
  const kindOptions = counts.rows.map((r) => ({
    value: r.kind,
    label: r.kind === 'built_in' ? t('kind.builtIn') : t('kind.custom'),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canCreate ? <NewReportButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips
              basePath="/reports/custom"
              currentParams={sp}
              paramKey="kind"
              label={t('list.kindFilterLabel')}
              options={kindOptions}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={canCreate ? <NewReportButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/reports/custom" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                  {t('list.columns.report')}
                </SortTh>
                <TableHead>{tc('labels.description')}</TableHead>
                <SortTh basePath="/reports/custom" currentParams={sp} column="kind" sort={params.sort} dir={params.dir}>
                  {t('list.columns.kind')}
                </SortTh>
                <SortTh basePath="/reports/custom" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>
                  {tc('labels.updated')}
                </SortTh>
                <TableHead className="text-right">{tc('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {defs.rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link
                      href={`/reports/custom/run/${d.id}`}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {d.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {summarizePlan(d.query as ReportCustomQuery)}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md text-sm text-slate-600 dark:text-slate-300">
                    {d.description ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={KIND_VARIANT[d.kind] ?? 'outline'}>
                      {d.kind === 'built_in' ? t('kind.builtIn') : t('kind.custom')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-500 tabular-nums dark:text-slate-400">
                    {String(d.updated_at).slice(0, 10)}
                  </TableCell>
                  <TableCell className="text-right">
                    <CustomReportActions id={d.id} kind={d.kind} canCreate={canCreate} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination
              basePath="/reports/custom"
              currentParams={sp}
              total={filteredTotal}
              page={params.page}
              perPage={params.perPage}
            />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
