import Link from 'next/link'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { partnerBalances } from '../../../../lib/reports'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

export default async function Partners({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams
  const k = kind === 'receivable' ? 'receivable' : 'payable'
  const rows = await partnerBalances(k)
  const total = rows.reduce((a, r) => a + Number(r.balance), 0)
  const flip = k === 'payable' ? -1 : 1

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
    </ListPageLayout>
  )
}
