import Link from 'next/link'
import { DetailHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { accountRegister } from '../../../../lib/reports'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

const PER_PAGE = 100

export default async function Register({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { id } = await params
  const { page } = await searchParams
  const p = Math.max(1, Number(page ?? 1))
  const { account, lines, total, balance } = await accountRegister(id, PER_PAGE, (p - 1) * PER_PAGE)
  if (!account) return <PageContainer>Account not found</PageContainer>

  return (
    <PageContainer>
      <DetailHeader
        title={`${account.number ?? ''} ${account.name}`.trim()}
        subtitle={`register · ${total.toLocaleString()} lines · running balance ${money(balance)}`}
        back={{ href: '/accounts', label: 'Chart of Accounts' }}
      />
      <div className="mt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Memo</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l: any, i: number) => {
              const amt = Number(l.amount)
              return (
                <TableRow key={`${l.entry_id}-${l.line_number}-${i}`}>
                  <TableCell className="whitespace-nowrap">{l.posting_date}</TableCell>
                  <TableCell className="font-mono text-[13px]">
                    <Link href={`/journal/${l.entry_id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {l.entry_number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.party}</TableCell>
                  <TableCell className="max-w-sm truncate text-slate-500 dark:text-slate-400">
                    {l.memo ?? l.entry_memo}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{amt > 0 ? money(amt) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt < 0 ? money(-amt) : ''}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <div className="mt-4">
          <Pagination basePath={`/accounts/${id}`} currentParams={{ page: String(p) }} page={p} perPage={PER_PAGE} total={total} />
        </div>
      </div>
    </PageContainer>
  )
}
