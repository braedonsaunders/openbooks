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
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'
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

  // Live bank-feed connections, surfaced read-only alongside the import history
  // when the feature is on. Managing them lives in Company Settings → Bank Feeds.
  const features = await resolvedFeatureState(authz.user.orgId)
  const feedsEnabled = featureEnabled(features, 'bankFeeds')
  const feeds = feedsEnabled
    ? ((await db.execute(sql`
        select c.name, c.provider, c.status, c.last_sync_at, c.last_error, c.is_active,
               a.number as account_number, a.name as account_name
          from bank_feed_connections c
          join accounts a on a.id = c.account_id and a.org_id = c.org_id
         where c.org_id = ${authz.user.orgId} and c.provider in ('plaid','gocardless','truelayer')
         order by c.created_at desc
      `)) as unknown as { rows: any[] }).rows
    : []

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
      {feedsEnabled && (
        <section className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('bankFeeds.operational.title')}</h3>
            <Link href={'/admin/setup/bank-feeds' as any} className="text-sm text-teal-700 hover:underline dark:text-teal-300">
              {t('bankFeeds.operational.manage')}
            </Link>
          </div>
          {feeds.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{t('bankFeeds.operational.none')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {feeds.map((f: any, i: number) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{f.name}</span>
                  <Badge variant="outline">{f.provider}</Badge>
                  <span className="text-slate-500 dark:text-slate-400">
                    <span className="font-mono text-[13px] font-semibold">{f.account_number}</span> {f.account_name}
                  </span>
                  <Badge variant={f.status === 'connected' ? 'default' : 'secondary'}>{f.status}</Badge>
                  {!f.is_active && <span className="text-xs text-slate-400">(paused)</span>}
                  <span className="ml-auto text-slate-500 dark:text-slate-400">
                    {t('bankFeeds.operational.lastSync')}:{' '}
                    {f.last_sync_at ? new Date(f.last_sync_at).toLocaleDateString('en-CA') : t('bankFeeds.operational.never')}
                  </span>
                  {f.last_error && <span className="w-full text-xs text-red-600" title={f.last_error}>⚠ {f.last_error}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
