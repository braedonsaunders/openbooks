import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  Button,
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

/** One-line human summary of what a plan does, for the list. */
function summarizePlan(query: ReportCustomQuery): string {
  const entity = REPORT_ENTITY_MAP[query.entity]
  const source = entity?.label ?? query.entity
  if (query.mode === 'summarize') {
    const dims = (query.breakouts ?? []).length
    const measures = (query.measures ?? []).length || 1
    return `Summary of ${source} · ${dims} group${dims === 1 ? '' : 's'}, ${measures} measure${measures === 1 ? '' : 's'}`
  }
  const cols = (query.columns ?? []).length
  return `${source} detail · ${cols} column${cols === 1 ? '' : 's'}`
}

export default async function CustomReports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
    label: r.kind === 'built_in' ? 'Built-in' : 'Custom',
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Custom Reports"
            description="Build, save, run and schedule reports over the ledger — detail rows or grouped summaries, with filters, breakouts and measures."
            actions={canCreate ? <NewReportButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search reports…" />
            <FilterChips
              basePath="/reports/custom"
              currentParams={sp}
              paramKey="kind"
              label="Kind"
              options={kindOptions}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No reports yet"
          description="Seed the built-in reports or build your first custom report to get started."
          action={canCreate ? <NewReportButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/reports/custom" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                  Report
                </SortTh>
                <TableHead>Description</TableHead>
                <SortTh basePath="/reports/custom" currentParams={sp} column="kind" sort={params.sort} dir={params.dir}>
                  Kind
                </SortTh>
                <SortTh basePath="/reports/custom" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>
                  Updated
                </SortTh>
                <TableHead className="text-right">Actions</TableHead>
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
                      {d.kind === 'built_in' ? 'Built-in' : 'Custom'}
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
