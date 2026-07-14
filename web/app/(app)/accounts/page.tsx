import Link from 'next/link'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { accountsWithBalances } from '../../../lib/data'
import { money } from '../../../lib/format'

export const dynamic = 'force-dynamic'

const TYPE_LABELS: Record<string, string> = {
  asset_bank: 'Bank',
  asset_receivable: 'Accounts Receivable',
  asset_current_other: 'Other Current Assets',
  asset_fixed: 'Fixed Assets',
  asset_other: 'Other Assets',
  liability_payable: 'Accounts Payable',
  liability_card: 'Corporate Cards',
  liability_current_other: 'Other Current Liabilities',
  liability_long_term: 'Long-Term Liabilities',
  equity: 'Equity',
  income: 'Income',
  income_other: 'Other Income',
  cogs: 'Cost of Goods Sold',
  expense: 'Expenses',
  expense_other: 'Other Expenses',
  expense_deferred: 'Deferred Expenses',
}

export default async function Accounts() {
  const accounts = await accountsWithBalances()

  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rolled = new Map<string, number>(accounts.map((a) => [a.id, Number(a.balance)]))
  for (const a of accounts) {
    let p = a.parent_id
    while (p) {
      rolled.set(p, (rolled.get(p) ?? 0) + Number(a.balance))
      p = byId.get(p)?.parent_id ?? null
    }
  }
  const depth = (a: (typeof accounts)[number]) => {
    let d = 0
    let p = a.parent_id
    while (p) {
      d++
      p = byId.get(p)?.parent_id ?? null
    }
    return Math.min(d, 2)
  }
  const children = new Map<string | null, typeof accounts>()
  for (const a of accounts) {
    if (!children.has(a.parent_id)) children.set(a.parent_id, [])
    children.get(a.parent_id)!.push(a)
  }
  const ordered: typeof accounts = []
  const walk = (parent: string | null) => {
    for (const a of children.get(parent) ?? []) {
      ordered.push(a)
      walk(a.id)
    }
  }
  walk(null)

  let currentType = ''

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Chart of Accounts"
          description={`${accounts.length} accounts · balances from the ledger, rolled up through summary accounts.`}
        />
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">Number</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((a) => {
            const bal = rolled.get(a.id) ?? 0
            const showHeader = a.type !== currentType && !a.parent_id
            if (showHeader) currentType = a.type
            const d = depth(a)
            return [
              showHeader ? (
                <TableRow key={`${a.id}-h`}>
                  <TableCell
                    colSpan={3}
                    className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
                  >
                    {TYPE_LABELS[a.type] ?? a.type}
                  </TableCell>
                </TableRow>
              ) : null,
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{a.number}</TableCell>
                <TableCell className={cn(d === 1 && 'pl-8', d === 2 && 'pl-12')}>
                  <Link
                    href={`/accounts/${a.id}`}
                    className={cn('hover:text-teal-700 dark:hover:text-teal-300', a.is_summary && 'font-semibold')}
                  >
                    {a.name}
                  </Link>
                  {!a.is_active ? (
                    <Badge variant="outline" className="ml-2">
                      inactive
                    </Badge>
                  ) : null}
                  {a.is_summary ? (
                    <Badge variant="secondary" className="ml-2">
                      summary
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(bal)}
                </TableCell>
              </TableRow>,
            ]
          })}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
