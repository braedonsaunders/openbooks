import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { requirePermission, can } from '../../../../lib/authz'
import { isUuid, parsePrefixedListParams, pickString } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'
import { ImportStatementButton } from './ImportStatementButton'
import { StartReconciliationButton } from './StartReconciliationButton'
import { StatementDrawer } from './StatementDrawer'

export const dynamic = 'force-dynamic'

const RECON_VARIANT: Record<string, 'success' | 'secondary' | 'warning'> = {
  signed_off: 'success',
  balanced: 'warning',
  in_progress: 'secondary',
}

// Enum values with translated labels — unknown values render as the raw code
// with underscores spaced out.
const TYPE_KEYS = ['asset_bank', 'liability_card']
const RECON_STATUS_KEYS = ['signed_off', 'balanced', 'in_progress']

const STMT_SORTS = {
  date: sql`s.statement_date`,
  source: sql`s.source`,
  lines: sql`coalesce(lc.n, 0)`,
  imported: sql`s.imported_at`,
} as const

const RECON_SORTS = {
  through: sql`r.through_date`,
  balance: sql`r.statement_balance`,
  status: sql`r.status`,
  created: sql`r.created_at`,
} as const

export default async function BankingAccount({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const reconStatusLabel = (status: string) =>
    RECON_STATUS_KEYS.includes(status) ? t(`reconStatus.${status}`) : String(status).replace(/_/g, ' ')
  const { accountId } = await params
  if (!isUuid(accountId)) notFound()
  const sp = await searchParams
  const basePath = `/banking/${accountId}`

  const accountRes = (await db.execute(sql`
    select a.id, a.number, a.name, a.type, a.currency_restriction,
           coalesce((select sum(jl.amount) from journal_lines jl
                      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
                     where jl.account_id = a.id), 0) as balance,
           (select max(r.through_date) from reconciliations r
             where r.account_id = a.id and r.status = 'signed_off') as reconciled_through,
           (select count(*) from bank_statement_lines l
             join bank_statements s on s.id = l.statement_id
            where s.account_id = a.id and l.match_status = 'unmatched') as unmatched_lines,
           (select r.id from reconciliations r
             where r.account_id = a.id and r.status <> 'signed_off'
             order by r.created_at desc limit 1) as open_reconciliation_id
      from accounts a
     where a.id = ${accountId} and a.reconcilable
  `)) as unknown as { rows: any[] }
  const account = accountRes.rows[0]
  if (!account) notFound()

  // -- statements list (prefixed: stmt*) ------------------------------------
  const stmtParams = parsePrefixedListParams(sp, 'stmt', {
    sort: 'date',
    dir: 'desc',
    perPage: 10,
    allowedSorts: ['date', 'source', 'lines', 'imported'] as const,
  })
  const source = pickString(sp.source)
  const stmtWhere = sql`s.account_id = ${accountId}
    ${source ? sql` and s.source = ${source}` : sql``}
    ${stmtParams.q ? sql` and (s.statement_date::text ilike ${'%' + stmtParams.q + '%'} or s.source ilike ${'%' + stmtParams.q + '%'})` : sql``}`

  // -- reconciliations list (prefixed: recon*) -------------------------------
  const reconParams = parsePrefixedListParams(sp, 'recon', {
    sort: 'created',
    dir: 'desc',
    perPage: 10,
    allowedSorts: ['through', 'balance', 'status', 'created'] as const,
  })
  const reconStatus = pickString(sp.reconStatus)
  const reconWhere = sql`r.account_id = ${accountId}
    ${reconStatus ? sql` and r.status = ${reconStatus}` : sql``}
    ${reconParams.q ? sql` and (r.through_date::text ilike ${'%' + reconParams.q + '%'} or r.statement_balance::text ilike ${'%' + reconParams.q + '%'})` : sql``}`

  const openStatementId = pickString(sp.statement)

  const [statements, stmtCount, sourceCounts, recons, reconCount, reconStatusCounts] = (await Promise.all([
    db.execute(sql`
      select s.id, s.source, s.statement_date, s.opening_balance, s.closing_balance, s.imported_at,
             coalesce(lc.n, 0) as line_count, coalesce(lc.unmatched, 0) as unmatched_count
        from bank_statements s
        left join lateral (
          select count(*) as n, count(*) filter (where l.match_status = 'unmatched') as unmatched
            from bank_statement_lines l where l.statement_id = s.id) lc on true
       where ${stmtWhere}
       order by ${STMT_SORTS[stmtParams.sort]} ${stmtParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}
    `),
    db.execute(sql`select count(*) as n from bank_statements s where ${stmtWhere}`),
    db.execute(sql`select s.source, count(*) as n from bank_statements s where s.account_id = ${accountId} group by s.source order by s.source`),
    db.execute(sql`
      select r.id, r.through_date, r.statement_balance, r.status, r.signed_off_at, r.created_at
        from reconciliations r
       where ${reconWhere}
       order by ${RECON_SORTS[reconParams.sort]} ${reconParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${reconParams.perPage} offset ${(reconParams.page - 1) * reconParams.perPage}
    `),
    db.execute(sql`select count(*) as n from reconciliations r where ${reconWhere}`),
    db.execute(sql`select r.status, count(*) as n from reconciliations r where r.account_id = ${accountId} group by r.status`),
  ])) as unknown as { rows: any[] }[]

  // -- statement drawer (?statement=<id>) ------------------------------------
  let drawer: { statement: any; lines: any[]; lineTotal: number; lineParams: any } | null = null
  if (openStatementId && isUuid(openStatementId)) {
    const s = (await db.execute(sql`
      select s.id, s.source, s.statement_date, s.opening_balance, s.closing_balance, s.imported_at
        from bank_statements s where s.id = ${openStatementId} and s.account_id = ${accountId}
    `)) as unknown as { rows: any[] }
    if (s.rows[0]) {
      const lineParams = parsePrefixedListParams(sp, 'sl', {
        sort: 'line',
        dir: 'asc',
        perPage: 25,
        allowedSorts: ['line', 'date', 'amount'] as const,
      })
      const lineSorts = { line: sql`l.line_number`, date: sql`l.posted_on`, amount: sql`l.amount` } as const
      const lineWhere = sql`l.statement_id = ${openStatementId}
        ${lineParams.q ? sql` and (l.description ilike ${'%' + lineParams.q + '%'} or l.counterparty_ref ilike ${'%' + lineParams.q + '%'})` : sql``}`
      const [lines, lineCount] = (await Promise.all([
        db.execute(sql`
          select l.id, l.line_number, l.posted_on, l.amount, l.description, l.counterparty_ref, l.match_status
            from bank_statement_lines l
           where ${lineWhere}
           order by ${lineSorts[lineParams.sort]} ${lineParams.dir === 'asc' ? sql`asc` : sql`desc`}
           limit ${lineParams.perPage} offset ${(lineParams.page - 1) * lineParams.perPage}
        `),
        db.execute(sql`select count(*) as n from bank_statement_lines l where ${lineWhere}`),
      ])) as unknown as { rows: any[] }[]
      drawer = {
        statement: s.rows[0],
        lines: lines.rows,
        lineTotal: Number(lineCount.rows[0].n),
        lineParams,
      }
    }
  }

  const sourceOptions = sourceCounts.rows.map((r: any) => ({ value: r.source, label: r.source, count: Number(r.n) }))
  const reconStatusOptions = reconStatusCounts.rows.map((r: any) => ({
    value: r.status,
    label: reconStatusLabel(r.status),
    count: Number(r.n),
  }))

  const typeLabel = TYPE_KEYS.includes(account.type)
    ? t(`types.${account.type}`)
    : String(account.type).replace(/_/g, ' ')
  const accountDetails = account.currency_restriction
    ? `${typeLabel} · ${account.currency_restriction}`
    : typeLabel

  const stat = 'rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'
  const statLabel = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/banking', label: t('overview.title') }}
            title={[account.number, account.name].filter(Boolean).join(' · ')}
            description={t('account.description', { details: accountDetails })}
            actions={
              canReconcile ? (
                <div className="flex items-center gap-2">
                  <ImportStatementButton accountId={account.id} />
                  <StartReconciliationButton
                    accountId={account.id}
                    openReconciliationId={account.open_reconciliation_id}
                    glBalance={String(account.balance)}
                  />
                </div>
              ) : undefined
            }
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className={stat}>
              <div className={statLabel}>{t('account.stats.glBalance')}</div>
              <div className="text-sm font-semibold tabular-nums">{money(account.balance)}</div>
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('account.stats.reconciledThrough')}</div>
              <div className="text-sm font-semibold">
                {account.reconciled_through ?? <span className="font-normal text-slate-400 dark:text-slate-500">{t('labels.never')}</span>}
              </div>
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('account.stats.unmatchedLines')}</div>
              <div className="text-sm font-semibold tabular-nums">{Number(account.unmatched_lines).toLocaleString()}</div>
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('account.stats.reconciliation')}</div>
              <div className="text-sm font-semibold">
                {account.open_reconciliation_id ? (
                  <Badge variant="warning">{t('account.badges.inProgress')}</Badge>
                ) : (
                  <Badge variant="secondary">{t('account.badges.noneOpen')}</Badge>
                )}
              </div>
            </div>
          </div>
        </>
      }
    >
      <div className="space-y-8">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{t('account.statementsTitle')}</h2>
            <SearchInput placeholder={t('account.searchStatements')} paramKey="stmtQ" pageParamKey="stmtPage" />
            <FilterChips basePath={basePath} currentParams={sp} paramKey="source" label={t('labels.source')} options={sourceOptions} pageParamKey="stmtPage" />
          </div>
          {Number(stmtCount.rows[0].n) === 0 && !stmtParams.q && !source ? (
            <EmptyState
              title={t('account.statementsEmptyTitle')}
              description={t('account.statementsEmptyDescription')}
              action={canReconcile ? <ImportStatementButton accountId={account.id} /> : undefined}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortTh basePath={basePath} currentParams={sp} column="date" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{t('labels.statementDate')}</SortTh>
                    <SortTh basePath={basePath} currentParams={sp} column="source" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{t('labels.source')}</SortTh>
                    <SortTh basePath={basePath} currentParams={sp} column="lines" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage" align="right">{tCommon('labels.lines')}</SortTh>
                    <TableHead className="text-right">{t('account.columns.unmatched')}</TableHead>
                    <TableHead className="text-right">{t('account.columns.opening')}</TableHead>
                    <TableHead className="text-right">{t('account.columns.closing')}</TableHead>
                    <SortTh basePath={basePath} currentParams={sp} column="imported" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{t('account.columns.imported')}</SortTh>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statements.rows.map((s: any) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`${basePath}?statement=${s.id}` as any}
                          className="text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {s.statement_date}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{s.source}</Badge>
                      </TableCell>
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
              <Pagination basePath={basePath} currentParams={sp} total={Number(stmtCount.rows[0].n)} page={stmtParams.page} perPage={stmtParams.perPage} pageParamKey="stmtPage" />
            </>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{t('account.reconciliationsTitle')}</h2>
            <SearchInput placeholder={t('account.searchReconciliations')} paramKey="reconQ" pageParamKey="reconPage" />
            <FilterChips basePath={basePath} currentParams={sp} paramKey="reconStatus" label={tCommon('labels.status')} options={reconStatusOptions} pageParamKey="reconPage" />
          </div>
          {Number(reconCount.rows[0].n) === 0 && !reconParams.q && !reconStatus ? (
            <EmptyState
              title={t('account.reconciliationsEmptyTitle')}
              description={t('account.reconciliationsEmptyDescription')}
              action={
                canReconcile ? (
                  <StartReconciliationButton
                    accountId={account.id}
                    openReconciliationId={account.open_reconciliation_id}
                    glBalance={String(account.balance)}
                  />
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortTh basePath={basePath} currentParams={sp} column="through" sort={reconParams.sort} dir={reconParams.dir} sortParamKey="reconSort" dirParamKey="reconDir" pageParamKey="reconPage">{t('account.columns.throughDate')}</SortTh>
                    <SortTh basePath={basePath} currentParams={sp} column="balance" sort={reconParams.sort} dir={reconParams.dir} sortParamKey="reconSort" dirParamKey="reconDir" pageParamKey="reconPage" align="right">{t('labels.statementBalance')}</SortTh>
                    <SortTh basePath={basePath} currentParams={sp} column="status" sort={reconParams.sort} dir={reconParams.dir} sortParamKey="reconSort" dirParamKey="reconDir" pageParamKey="reconPage">{tCommon('labels.status')}</SortTh>
                    <SortTh basePath={basePath} currentParams={sp} column="created" sort={reconParams.sort} dir={reconParams.dir} sortParamKey="reconSort" dirParamKey="reconDir" pageParamKey="reconPage">{t('account.columns.started')}</SortTh>
                    <TableHead>{t('account.columns.signedOff')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recons.rows.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.through_date}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.statement_balance)}</TableCell>
                      <TableCell>
                        <Badge variant={RECON_VARIANT[r.status] ?? 'secondary'}>{reconStatusLabel(r.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">
                        {new Date(r.created_at).toLocaleDateString('en-CA')}
                      </TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">
                        {r.signed_off_at ? new Date(r.signed_off_at).toLocaleDateString('en-CA') : '—'}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`${basePath}/reconcile/${r.id}` as any}>
                            {r.status === 'signed_off' ? tCommon('actions.view') : t('account.openWorkspace')}
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination basePath={basePath} currentParams={sp} total={Number(reconCount.rows[0].n)} page={reconParams.page} perPage={reconParams.perPage} pageParamKey="reconPage" />
            </>
          )}
        </section>
      </div>

      {drawer ? (
        <StatementDrawer
          basePath={basePath}
          currentParams={sp}
          statement={drawer.statement}
          lines={drawer.lines}
          lineTotal={drawer.lineTotal}
          page={drawer.lineParams.page}
          perPage={drawer.lineParams.perPage}
          sort={drawer.lineParams.sort}
          dir={drawer.lineParams.dir}
        />
      ) : null}
    </ListPageLayout>
  )
}
