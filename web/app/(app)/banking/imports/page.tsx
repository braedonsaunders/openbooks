import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('imports.title') }
}

const SORT_COLUMNS = {
  date: sql`s.statement_date`,
  account: sql`a.number`,
  source: sql`s.source`,
  lines: sql`coalesce(lc.n, 0)`,
  imported: sql`s.imported_at`,
} as const

export default async function BankingImports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const sp = await searchParams

  const params = parseListParams(sp, {
    sort: 'imported',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'account', 'source', 'lines', 'imported'] as const,
  })
  const source = pickString(sp.source)
  const account = pickString(sp.account)
  const where = sql`s.org_id = ${authz.user.orgId}
    ${source ? sql` and s.source = ${source}` : sql``}
    ${account ? sql` and s.account_id = ${account}` : sql``}
    ${params.q ? sql` and (s.statement_date::text ilike ${'%' + params.q + '%'} or s.source ilike ${'%' + params.q + '%'} or a.number ilike ${'%' + params.q + '%'} or a.name ilike ${'%' + params.q + '%'})` : sql``}`

  const [rows, count, sourceCounts, accountCounts] = (await Promise.all([
    db.execute(sql`
      select s.id, s.source, s.statement_date, s.opening_balance, s.closing_balance, s.imported_at,
             s.account_id, a.number as account_number, a.name as account_name,
             coalesce(lc.n, 0) as line_count, coalesce(lc.unmatched, 0) as unmatched_count
        from bank_statements s
        join accounts a on a.id = s.account_id
        left join lateral (
          select count(*) as n, count(*) filter (where l.match_status = 'unmatched') as unmatched
            from bank_statement_lines l where l.statement_id = s.id) lc on true
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`select count(*) as n from bank_statements s join accounts a on a.id = s.account_id where ${where}`),
    db.execute(sql`select s.source, count(*) as n from bank_statements s where s.org_id = ${authz.user.orgId} group by s.source order by s.source`),
    db.execute(sql`
      select s.account_id, a.number, a.name, count(*) as n
        from bank_statements s join accounts a on a.id = s.account_id
       where s.org_id = ${authz.user.orgId}
       group by s.account_id, a.number, a.name order by a.number
    `),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] }]

  const total = Number(count.rows[0].n)
  const sourceOptions = sourceCounts.rows.map((r: any) => ({ value: r.source, label: r.source, count: Number(r.n) }))
  const accountOptions = accountCounts.rows.map((r: any) => ({
    value: r.account_id,
    label: [r.number, r.name].filter(Boolean).join(' · '),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('overview.title') }}
          title={t('imports.title')}
          description={t('imports.description')}
        />
      }
    >
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('imports.search')} />
          <FilterChips basePath="/banking/imports" currentParams={sp} paramKey="source" label={t('labels.source')} options={sourceOptions} />
          <FilterChips basePath="/banking/imports" currentParams={sp} paramKey="account" label={tCommon('labels.account')} options={accountOptions} />
        </div>
        {total === 0 && !params.q && !source && !account ? (
          <EmptyState title={t('imports.emptyTitle')} description={t('imports.emptyDescription')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath="/banking/imports" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{t('labels.statementDate')}</SortTh>
                  <SortTh basePath="/banking/imports" currentParams={sp} column="account" sort={params.sort} dir={params.dir}>{tCommon('labels.account')}</SortTh>
                  <SortTh basePath="/banking/imports" currentParams={sp} column="source" sort={params.sort} dir={params.dir}>{t('labels.source')}</SortTh>
                  <SortTh basePath="/banking/imports" currentParams={sp} column="lines" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.lines')}</SortTh>
                  <TableHead className="text-right">{t('account.columns.unmatched')}</TableHead>
                  <TableHead className="text-right">{t('account.columns.opening')}</TableHead>
                  <TableHead className="text-right">{t('account.columns.closing')}</TableHead>
                  <SortTh basePath="/banking/imports" currentParams={sp} column="imported" sort={params.sort} dir={params.dir}>{t('account.columns.imported')}</SortTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.rows.map((s: any) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <Link href={`/banking/${s.account_id}?statement=${s.id}` as any} className="text-teal-700 hover:underline dark:text-teal-300">
                        {s.statement_date}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/banking/${s.account_id}` as any} className="hover:underline">
                        <span className="font-mono text-[13px] font-semibold">{s.account_number}</span>
                        <span className="ml-1.5 text-slate-500 dark:text-slate-400">{s.account_name}</span>
                      </Link>
                    </TableCell>
                    <TableCell><Badge variant="outline">{s.source}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{Number(s.line_count).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(s.unmatched_count) > 0 ? (
                        Number(s.unmatched_count).toLocaleString()
                      ) : (
                        <span className="text-green-600 dark:text-green-400">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(s.opening_balance)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(s.closing_balance)}</TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {new Date(s.imported_at).toLocaleDateString('en-CA')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination basePath="/banking/imports" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </>
        )}
      </section>
    </ListPageLayout>
  )
}
