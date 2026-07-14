import Link from 'next/link'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { Pagination } from '../../../components/pagination'
import { journalPage } from '../../../lib/data'
import { money } from '../../../lib/format'

export const dynamic = 'force-dynamic'

const PER_PAGE = 50

export default async function Journal({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams
  const p = Math.max(1, Number(page ?? 1))
  const { entries, total } = await journalPage((p - 1) * PER_PAGE, PER_PAGE)

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Journal"
          description={`${total.toLocaleString()} posted entries · immutable, append-only.`}
        />
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Memo</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead className="text-right">Debits</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e: any) => (
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
      <div className="mt-4">
        <Pagination basePath="/journal" currentParams={{ page: String(p) }} page={p} perPage={PER_PAGE} total={total} />
      </div>
    </ListPageLayout>
  )
}
