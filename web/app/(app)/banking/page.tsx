import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { requirePermission } from '../../../lib/authz'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  number: sql`a.number`,
  name: sql`a.name`,
  balance: sql`coalesce(bal.balance, 0)`,
  reconciled: sql`lastrec.through_date`,
  unmatched: sql`coalesce(unm.n, 0)`,
} as const

const TYPE_LABEL: Record<string, string> = {
  asset_bank: 'Bank',
  liability_card: 'Card',
}

export default async function Banking({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('banking.read')
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'number',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['number', 'name', 'balance', 'reconciled', 'unmatched'] as const,
  })
  const type = pickString(sp.type)

  const where = sql`a.reconcilable and not a.is_summary
    ${type ? sql` and a.type = ${type}` : sql``}
    ${params.q ? sql` and (a.number ilike ${'%' + params.q + '%'} or a.name ilike ${'%' + params.q + '%'})` : sql``}`

  const [accounts, typeCounts, filtered] = (await Promise.all([
    db.execute(sql`
      select a.id, a.number, a.name, a.type, a.currency_restriction, a.is_active,
             coalesce(bal.balance, 0) as balance,
             lastrec.through_date as reconciled_through,
             coalesce(unm.n, 0) as unmatched_lines,
             openrec.id as open_reconciliation_id
        from accounts a
        left join lateral (
          select sum(jl.amount) as balance
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
           where jl.account_id = a.id) bal on true
        left join lateral (
          select max(r.through_date) as through_date
            from reconciliations r
           where r.account_id = a.id and r.status = 'signed_off') lastrec on true
        left join lateral (
          select count(*) as n
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id
           where s.account_id = a.id and l.match_status = 'unmatched') unm on true
        left join lateral (
          select r.id from reconciliations r
           where r.account_id = a.id and r.status <> 'signed_off'
           order by r.created_at desc limit 1) openrec on true
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`
      select a.type, count(*) as n from accounts a
       where a.reconcilable and not a.is_summary group by a.type order by a.type
    `),
    db.execute(sql`select count(*) as n from accounts a where ${where}`),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }]

  const total = typeCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = Number(filtered.rows[0].n)
  const typeOptions = typeCounts.rows.map((r: any) => ({
    value: r.type,
    label: TYPE_LABEL[r.type] ?? String(r.type).replace(/_/g, ' '),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Banking"
            description="Reconcilable accounts — import bank statements, match activity against the ledger, and sign off reconciliations."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search accounts…" />
            <FilterChips basePath="/banking" currentParams={sp} paramKey="type" label="Type" options={typeOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No reconcilable accounts"
          description="Mark your bank, card, and clearing accounts as reconcilable in the chart of accounts to start reconciling them here."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/banking" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>Account</SortTh>
                <SortTh basePath="/banking" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>Name</SortTh>
                <TableHead>Type</TableHead>
                <SortTh basePath="/banking" currentParams={sp} column="balance" sort={params.sort} dir={params.dir} align="right">GL balance</SortTh>
                <SortTh basePath="/banking" currentParams={sp} column="reconciled" sort={params.sort} dir={params.dir}>Reconciled through</SortTh>
                <SortTh basePath="/banking" currentParams={sp} column="unmatched" sort={params.sort} dir={params.dir} align="right">Unmatched lines</SortTh>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.rows.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link href={`/banking/${a.id}` as any} className="text-teal-700 hover:underline dark:text-teal-300">
                      {a.number ?? '—'}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/banking/${a.id}` as any} className="hover:underline">
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {TYPE_LABEL[a.type] ?? String(a.type).replace(/_/g, ' ')}
                    {a.currency_restriction ? ` · ${a.currency_restriction}` : ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(a.balance)}</TableCell>
                  <TableCell>{a.reconciled_through ?? <span className="text-slate-400 dark:text-slate-500">never</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(a.unmatched_lines).toLocaleString()}</TableCell>
                  <TableCell>
                    {a.open_reconciliation_id ? (
                      <Badge variant="warning">reconciling</Badge>
                    ) : Number(a.unmatched_lines) > 0 ? (
                      <Badge variant="secondary">lines to match</Badge>
                    ) : (
                      <Badge variant="success">up to date</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/banking" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
