import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
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
  return { title: t('reconsPage.title') }
}

const RECON_VARIANT: Record<string, 'success' | 'secondary' | 'warning'> = {
  signed_off: 'success',
  balanced: 'warning',
  in_progress: 'secondary',
}
const RECON_STATUS_KEYS = ['signed_off', 'balanced', 'in_progress']

const SORT_COLUMNS = {
  account: sql`a.number`,
  through: sql`r.through_date`,
  balance: sql`r.statement_balance`,
  status: sql`r.status`,
  created: sql`r.created_at`,
} as const

export default async function BankingReconciliations({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const reconStatusLabel = (status: string) =>
    RECON_STATUS_KEYS.includes(status) ? t(`reconStatus.${status}`) : String(status).replace(/_/g, ' ')
  const sp = await searchParams

  const params = parseListParams(sp, {
    sort: 'created',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['account', 'through', 'balance', 'status', 'created'] as const,
  })
  const status = pickString(sp.status)
  const account = pickString(sp.account)
  const where = sql`r.org_id = ${authz.user.orgId}
    ${status ? sql` and r.status = ${status}` : sql``}
    ${account ? sql` and r.account_id = ${account}` : sql``}
    ${params.q ? sql` and (r.through_date::text ilike ${'%' + params.q + '%'} or a.number ilike ${'%' + params.q + '%'} or a.name ilike ${'%' + params.q + '%'})` : sql``}`

  const [rows, count, statusCounts, accountCounts] = (await Promise.all([
    db.execute(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance, r.status, r.signed_off_at, r.created_at,
             a.number as account_number, a.name as account_name
        from reconciliations r
        join accounts a on a.id = r.account_id
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`select count(*) as n from reconciliations r join accounts a on a.id = r.account_id where ${where}`),
    db.execute(sql`select r.status, count(*) as n from reconciliations r where r.org_id = ${authz.user.orgId} group by r.status`),
    db.execute(sql`
      select r.account_id, a.number, a.name, count(*) as n
        from reconciliations r join accounts a on a.id = r.account_id
       where r.org_id = ${authz.user.orgId}
       group by r.account_id, a.number, a.name order by a.number
    `),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] }]

  const total = Number(count.rows[0].n)
  const statusOptions = statusCounts.rows.map((r: any) => ({
    value: r.status,
    label: reconStatusLabel(r.status),
    count: Number(r.n),
  }))
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
          title={t('reconsPage.title')}
          description={t('reconsPage.description')}
        />
      }
    >
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('reconsPage.search')} />
          <FilterChips basePath="/banking/reconciliations" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          <FilterChips basePath="/banking/reconciliations" currentParams={sp} paramKey="account" label={tCommon('labels.account')} options={accountOptions} />
        </div>
        {total === 0 && !params.q && !status && !account ? (
          <EmptyState title={t('reconsPage.emptyTitle')} description={t('reconsPage.emptyDescription')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath="/banking/reconciliations" currentParams={sp} column="account" sort={params.sort} dir={params.dir}>{tCommon('labels.account')}</SortTh>
                  <SortTh basePath="/banking/reconciliations" currentParams={sp} column="through" sort={params.sort} dir={params.dir}>{t('account.columns.throughDate')}</SortTh>
                  <SortTh basePath="/banking/reconciliations" currentParams={sp} column="balance" sort={params.sort} dir={params.dir} align="right">{t('labels.statementBalance')}</SortTh>
                  <SortTh basePath="/banking/reconciliations" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tCommon('labels.status')}</SortTh>
                  <SortTh basePath="/banking/reconciliations" currentParams={sp} column="created" sort={params.sort} dir={params.dir}>{t('account.columns.started')}</SortTh>
                  <TableHead>{t('account.columns.signedOff')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.rows.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/banking/${r.account_id}` as any} className="hover:underline">
                        <span className="font-mono text-[13px] font-semibold">{r.account_number}</span>
                        <span className="ml-1.5 text-slate-500 dark:text-slate-400">{r.account_name}</span>
                      </Link>
                    </TableCell>
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
                        <Link href={`/banking/${r.account_id}/reconcile/${r.id}` as any}>
                          {r.status === 'signed_off' ? tCommon('actions.view') : t('account.openWorkspace')}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination basePath="/banking/reconciliations" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </>
        )}
      </section>
    </ListPageLayout>
  )
}
