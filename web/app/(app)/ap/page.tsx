import Link from 'next/link'
import { Plus } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { BillActions } from './BillActions'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  vendor: sql`p.display_name`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

export default async function AP({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'vendor', 'total', 'status'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`d.kind = 'vendor_bill'
    ${status ? sql` and d.status = ${status}` : sql``}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.reference_number ilike ${'%' + params.q + '%'})` : sql``}`

  const [bills, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.document_date, d.status, d.total,
             d.reference_number, p.display_name as vendor, e.id as entry_id
        from documents d
        left join parties p on p.id = d.party_id
        left join journal_entries e on e.id = d.posted_entry_id
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select d.status, count(*) as n from documents d
        left join parties p on p.id = d.party_id
       where d.kind = 'vendor_bill'
       group by d.status
    `) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = status || params.q
    ? Number(((await db.execute(sql`
        select count(*) as n from documents d
          left join parties p on p.id = d.party_id
         where ${where}`)) as any).rows[0].n)
    : total

  const statusOptions = counts.rows.map((r: any) => ({
    value: r.status,
    label: String(r.status).replace('_', ' '),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Accounts Payable"
            description="Vendor bills entered in openbooks — draft → approval → posted through the kernel."
            actions={
              <Button asChild>
                <Link href="/ap/new">
                  <Plus size={15} /> New bill
                </Link>
              </Button>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search bills, vendors, refs…" />
            <FilterChips basePath="/ap" currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No bills yet"
          description="Enter the first vendor bill to start the AP workflow."
          action={
            <Button asChild>
              <Link href="/ap/new">New bill</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/ap" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>Bill</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="vendor" sort={params.sort} dir={params.dir}>Vendor</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>Date</SortTh>
                <TableHead>Ref</TableHead>
                <SortTh basePath="/ap" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">Total</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>Status</SortTh>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.rows.map((b: any) => (
                <TableRow key={b.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    {b.entry_id ? (
                      <Link href={`/journal/${b.entry_id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {b.document_number}
                      </Link>
                    ) : (
                      b.document_number
                    )}
                  </TableCell>
                  <TableCell>{b.vendor}</TableCell>
                  <TableCell>{b.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{b.reference_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(b.total)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[b.status] ?? 'secondary'}>
                      {String(b.status).replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <BillActions id={b.id} status={b.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/ap" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
