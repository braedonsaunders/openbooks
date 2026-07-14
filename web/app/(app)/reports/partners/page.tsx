import Link from 'next/link'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { parseListParams } from '../../../../lib/list-params'
import { partnerBalances } from '../../../../lib/reports'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'
const PER_PAGE = 50

export default async function Partners({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const k = sp.kind === 'receivable' ? 'receivable' : 'payable'
  const params = parseListParams(sp, { sort: 'balance', allowedSorts: ['balance'] as const, perPage: PER_PAGE })
  const flip = k === 'payable' ? -1 : 1
  const all = await partnerBalances(k)
  const q = params.q?.toLowerCase()
  const filtered = q ? all.filter((r) => (r.display_name ?? '').toLowerCase().includes(q)) : all
  const total = filtered.reduce((a, r) => a + Number(r.balance), 0)
  const rows = filtered.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={k === 'payable' ? 'Payables by Vendor' : 'Receivables by Customer'}
            description="Net position per party, from open-item ledger lines."
            back={{ href: '/reports', label: 'Reports' }}
          />
          <div className="flex items-center gap-2">
            <Link href="/reports/partners?kind=payable">
              <Badge variant={k === 'payable' ? 'default' : 'outline'}>Payables</Badge>
            </Link>
            <Link href="/reports/partners?kind=receivable">
              <Badge variant={k === 'receivable' ? 'default' : 'outline'}>Receivables</Badge>
            </Link>
          </div>
          <SearchInput placeholder="Search party…" />
          <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  Total outstanding
                </span>
                <span className="block text-xl font-semibold tabular-nums">{money(flip * total)}</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  Parties with balance
                </span>
                <span className="block text-xl font-semibold tabular-nums">{rows.length}</span>
              </CardContent>
            </Card>
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Party</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="text-right">GL lines</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id ?? `none-${i}`}>
              <TableCell>
                {r.display_name ?? <span className="text-slate-400 italic">(no party on lines)</span>}
              </TableCell>
              <TableCell
                className={cn('text-right tabular-nums', flip * Number(r.balance) < 0 && 'text-red-600 dark:text-red-400')}
              >
                {money(flip * Number(r.balance))}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.line_count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/reports/partners" currentParams={sp} total={filtered.length} page={params.page} perPage={PER_PAGE} />
      </div>
    </ListPageLayout>
  )
}
