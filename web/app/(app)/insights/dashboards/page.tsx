import Link from 'next/link'
import { sql } from 'drizzle-orm'
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
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { can, requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { InsightsTabs } from '../InsightsTabs'
import { NewDashboardButton } from './NewDashboardButton'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`name`,
  updated: sql`updated_at`,
} as const

export default async function InsightsDashboards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['name', 'updated'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam === 'draft' || statusParam === 'published' ? statusParam : undefined

  const where = sql`org_id = ${orgId}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}
    ${status ? sql` and status = ${status}` : sql``}`

  const [dashboards, counts] = await Promise.all([
    db.execute(sql`
      select id, name, description, status, updated_at,
             jsonb_array_length(layout) as card_count
        from insight_dashboards
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total,
             count(*) filter (where status = 'draft') as drafts,
             count(*) filter (where status = 'published') as published
        from insight_dashboards where org_id = ${orgId}
    `) as any,
  ])
  const c = counts.rows[0]
  const total = Number(c.total)
  const filteredTotal =
    params.q || status
      ? Number(((await db.execute(sql`select count(*) as n from insight_dashboards where ${where}`)) as any).rows[0].n)
      : total

  const statusOptions = [
    { value: 'draft', label: 'Draft', count: Number(c.drafts) },
    { value: 'published', label: 'Published', count: Number(c.published) },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Insights"
            description="Arrange published cards on shared dashboards."
            actions={canCreate ? <NewDashboardButton /> : undefined}
          />
          <InsightsTabs active="dashboards" />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search dashboards…" />
            <FilterChips basePath="/insights/dashboards" currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description="Create a dashboard, then drop your published cards onto it."
          action={canCreate ? <NewDashboardButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/insights/dashboards" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                  Name
                </SortTh>
                <TableHead>Cards</TableHead>
                <TableHead>Status</TableHead>
                <SortTh basePath="/insights/dashboards" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>
                  Updated
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dashboards.rows.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell className="font-semibold">
                    <Link href={`/insights/dashboards/${row.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {row.name}
                    </Link>
                    {row.description ? (
                      <div className="text-xs font-normal text-slate-500 dark:text-slate-400">{row.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{Number(row.card_count)}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === 'published' ? 'success' : 'outline'}>
                      {row.status === 'published' ? 'Published' : 'Draft'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {new Date(row.updated_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/insights/dashboards" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
