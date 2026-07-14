import { Badge, DetailHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { entryDetail } from '../../../../lib/data'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

export default async function Entry({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { entry, lines } = await entryDetail(id)
  if (!entry) return <PageContainer>Entry not found</PageContainer>

  const debits = lines.filter((l: any) => Number(l.amount) > 0).reduce((a: number, l: any) => a + Number(l.amount), 0)

  return (
    <PageContainer>
      <DetailHeader
        title={entry.entry_number}
        subtitle={`${entry.posting_date} · ${entry.memo ?? ''} · origin: ${entry.origin}${entry.reverses_number ? ` · reverses ${entry.reverses_number}` : ''}`}
        badge={
          <Badge variant={entry.status === 'posted' ? 'success' : 'destructive'}>{entry.status}</Badge>
        }
        back={{ href: '/journal', label: 'Journal' }}
      />
      <div className="mt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead>Open item</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l: any) => {
              const amt = Number(l.amount)
              return (
                <TableRow key={l.line_number}>
                  <TableCell className="text-slate-400">{l.line_number}</TableCell>
                  <TableCell>
                    <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {l.account_number}
                    </span>
                    {l.account_name}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.party}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.department}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt > 0 ? money(amt) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt < 0 ? money(-amt) : ''}</TableCell>
                  <TableCell>{l.is_open_item ? <Badge variant="outline">open item</Badge> : null}</TableCell>
                </TableRow>
              )
            })}
            <TableRow>
              <TableCell colSpan={4} className="font-semibold">
                Totals
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(debits)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(debits)}</TableCell>
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  )
}
