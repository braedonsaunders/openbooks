import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  date: sql`e.posting_date`,
  number: sql`e.entry_number`,
  debits: sql`total_debits`,
} as const

export default async function Journal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ['date', 'number', 'debits'] as const,
  })
  const origin = pickString(sp.origin)

  const where = sql`true
    ${origin ? sql` and e.origin = ${origin}` : sql``}
    ${params.q ? sql` and (e.entry_number ilike ${'%' + params.q + '%'} or e.memo ilike ${'%' + params.q + '%'})` : sql``}`

  const [entries, totalRow, origins] = await Promise.all([
    db.execute(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
       where ${where}
       group by e.id
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`}, e.entry_number desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select count(*) as n from journal_entries e where ${where}`) as any,
    db.execute(sql`select origin, count(*) as n from journal_entries group by origin order by count(*) desc`) as any,
  ])
  const total = Number(totalRow.rows[0].n)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Journal"
            description={`${total.toLocaleString()} posted entries · immutable, append-only.`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search entry number or memo…" />
            <FilterChips
              basePath="/journal"
              currentParams={sp}
              paramKey="origin"
              label="Origin"
              options={origins.rows.map((r: any) => ({ value: r.origin, label: r.origin, count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <SortTh basePath="/journal" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>Date</SortTh>
            <SortTh basePath="/journal" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>Entry</SortTh>
            <TableHead>Memo</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <SortTh basePath="/journal" currentParams={sp} column="debits" sort={params.sort} dir={params.dir} align="right">Debits</SortTh>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.rows.map((e: any) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">{e.posting_date}</TableCell>
              <TableCell className="font-mono text-[13px] font-semibold">
                <Link href={`/journal/${e.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                  {e.entry_number}
                </Link>
              </TableCell>
              <TableCell className="max-w-md truncate text-slate-500 dark:text-slate-400">{e.memo}</TableCell>
              <TableCell>
                <Badge variant="secondary">{e.origin}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{e.line_count}</TableCell>
              <TableCell className="text-right tabular-nums">{money(e.total_debits)}</TableCell>
              <TableCell>
                <Badge variant={e.status === 'posted' ? 'success' : e.status === 'reversed' ? 'destructive' : 'secondary'}>
                  {e.status}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/journal" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
      </div>
    </ListPageLayout>
  )
}
