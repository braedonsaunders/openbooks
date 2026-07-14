import Link from 'next/link'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { parseListParams, pickString } from '../../../lib/list-params'
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
// Group the 16 detailed types into the 5 statement classes for the filter.
const CLASS_OF: Record<string, string> = {
  asset_bank: 'asset', asset_receivable: 'asset', asset_current_other: 'asset', asset_fixed: 'asset', asset_other: 'asset',
  liability_payable: 'liability', liability_card: 'liability', liability_current_other: 'liability', liability_long_term: 'liability',
  equity: 'equity',
  income: 'income', income_other: 'income',
  cogs: 'expense', expense: 'expense', expense_other: 'expense', expense_deferred: 'expense',
}
const CLASS_LABEL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' }
const FLAT_PER_PAGE = 50

export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'number', allowedSorts: ['number'] as const, perPage: FLAT_PER_PAGE })
  const q = params.q?.toLowerCase()
  const cls = pickString(sp.class)
  const filtering = !!q || !!cls

  const accounts = await accountsWithBalances()

  // roll balances up through summary parents (needed in both modes)
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
    let d = 0, p = a.parent_id
    while (p) { d++; p = byId.get(p)?.parent_id ?? null }
    return Math.min(d, 2)
  }

  const classCounts = Object.entries(
    accounts.reduce<Record<string, number>>((m, a) => {
      const c = CLASS_OF[a.type] ?? 'other'
      m[c] = (m[c] ?? 0) + 1
      return m
    }, {}),
  ).map(([value, count]) => ({ value, label: CLASS_LABEL[value] ?? value, count }))

  const header = (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="Natural-sign current balances (balance-sheet cumulative, P&L this fiscal year), rolled up through summary accounts."
      />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder="Search number or name…" />
        <FilterChips basePath="/accounts" currentParams={sp} paramKey="class" label="Class" options={classCounts} />
      </div>
    </>
  )

  // ---- filtered/searched → flat, paginated list ---------------------------
  if (filtering) {
    const matches = accounts
      .filter((a) => (!cls || CLASS_OF[a.type] === cls) && (!q || (a.number ?? '').toLowerCase().includes(q) || a.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))
    const total = matches.length
    const pageRows = matches.slice((params.page - 1) * FLAT_PER_PAGE, params.page * FLAT_PER_PAGE)
    return (
      <ListPageLayout header={header}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Number</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((a) => {
              const bal = rolled.get(a.id) ?? 0
              return (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{a.number}</TableCell>
                  <TableCell>
                    <Link href={`/accounts/${a.id}`} className={cn('hover:text-teal-700 dark:hover:text-teal-300', a.is_summary && 'font-semibold')}>
                      {a.name}
                    </Link>
                    {!a.is_active ? <Badge variant="outline" className="ml-2">inactive</Badge> : null}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{TYPE_LABELS[a.type] ?? a.type}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>{money(bal)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <div className="mt-3">
          <Pagination basePath="/accounts" currentParams={sp} total={total} page={params.page} perPage={FLAT_PER_PAGE} />
        </div>
      </ListPageLayout>
    )
  }

  // ---- default → the hierarchy tree, grouped by type ----------------------
  const children = new Map<string | null, typeof accounts>()
  for (const a of accounts) {
    if (!children.has(a.parent_id)) children.set(a.parent_id, [])
    children.get(a.parent_id)!.push(a)
  }
  const ordered: typeof accounts = []
  const walk = (parent: string | null) => {
    for (const a of children.get(parent) ?? []) { ordered.push(a); walk(a.id) }
  }
  walk(null)
  let currentType = ''

  return (
    <ListPageLayout header={header}>
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
                  <TableCell colSpan={3} className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300">
                    {TYPE_LABELS[a.type] ?? a.type}
                  </TableCell>
                </TableRow>
              ) : null,
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{a.number}</TableCell>
                <TableCell className={cn(d === 1 && 'pl-8', d === 2 && 'pl-12')}>
                  <Link href={`/accounts/${a.id}`} className={cn('hover:text-teal-700 dark:hover:text-teal-300', a.is_summary && 'font-semibold')}>
                    {a.name}
                  </Link>
                  {!a.is_active ? <Badge variant="outline" className="ml-2">inactive</Badge> : null}
                  {a.is_summary ? <Badge variant="secondary" className="ml-2">summary</Badge> : null}
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>{money(bal)}</TableCell>
              </TableRow>,
            ]
          })}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
