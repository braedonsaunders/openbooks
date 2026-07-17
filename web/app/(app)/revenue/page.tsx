import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { RunRecognitionButton } from './RunRecognitionButton'
import { ContractDrawer } from './ContractDrawer'
import { loadContract } from './_lib'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  number: sql`c.contract_number`,
  customer: sql`customer`,
  total: sql`c.total_transaction_price`,
} as const

const STATUS_VALUES = ['draft', 'active', 'complete', 'cancelled'] as const

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  active: 'success',
  complete: 'secondary',
  draft: 'outline',
  cancelled: 'warning',
}

export default async function Revenue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('revenue'), getTranslations('common')])

  const authz = await requirePermission('ar.read')
  const canRun = can(authz, 'ar.post')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const contractId = typeof sp.contract === 'string' ? sp.contract : undefined
  const params = parseListParams(sp, {
    sort: 'number',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['number', 'customer', 'total'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam && (STATUS_VALUES as readonly string[]).includes(statusParam) ? statusParam : undefined

  // Recognized/deferred rollups are scoped to the primary book.
  const rollup = sql`
    left join lateral (
      select coalesce(sum(l.planned_amount), 0) as planned,
             coalesce(sum(l.recognized_amount) filter (where l.journal_entry_id is not null), 0) as recognized
        from performance_obligations o
        join recognition_schedules s on s.obligation_id = o.id
        join accounting_books bk on bk.id = s.book_id and bk.is_primary
        join recognition_schedule_lines l on l.schedule_id = s.id
       where o.contract_id = c.id
    ) agg on true`

  const where = sql`c.org_id = ${orgId}
    ${
      params.q
        ? sql` and (c.contract_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${status ? sql` and c.status = ${status}` : sql``}`

  const [contracts, counts] = await Promise.all([
    db.execute(sql`
      select c.id, c.contract_number, c.status, c.currency, c.total_transaction_price,
             coalesce(p.display_name, '—') as customer,
             agg.planned, agg.recognized
        from revenue_contracts c
        left join parties p on p.id = c.customer_id
        ${rollup}
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total, c.status, count(*) as status_count
        from revenue_contracts c
       where c.org_id = ${orgId}
       group by rollup (c.status)
    `) as any,
  ])

  const grand = counts.rows.find((r: any) => r.status === null) ?? { total: 0 }
  const statusCounts = new Map<string, number>()
  for (const r of counts.rows as any[]) if (r.status !== null) statusCounts.set(r.status, Number(r.status_count))
  const total = Number(grand.total)
  const filteredTotal =
    params.q || status
      ? Number(
          (
            (await db.execute(
              sql`select count(*) as n from revenue_contracts c left join parties p on p.id = c.customer_id where ${where}`,
            )) as any
          ).rows[0].n,
        )
      : total

  const openContract =
    contractId && isUuid(contractId) ? await loadContract(contractId, orgId) : null

  const statusOptions = (STATUS_VALUES as readonly string[]).map((s) => ({
    value: s,
    label: t(`status.${s}`),
    count: statusCounts.get(s) ?? 0,
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canRun ? <RunRecognitionButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/revenue" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/revenue" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>
                  {t('labels.contract')}
                </SortTh>
                <SortTh basePath="/revenue" currentParams={sp} column="customer" sort={params.sort} dir={params.dir}>
                  {t('labels.customer')}
                </SortTh>
                <SortTh basePath="/revenue" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right" className="text-right">
                  {t('labels.total')}
                </SortTh>
                <TableHead className="text-right">{t('labels.recognized')}</TableHead>
                <TableHead className="text-right">{t('labels.deferred')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.rows.map((c: any) => {
                const deferred = Number(c.planned ?? 0) - Number(c.recognized ?? 0)
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-[13px]">
                      <Link href={`/revenue?contract=${c.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {c.contract_number}
                      </Link>
                    </TableCell>
                    <TableCell className="font-semibold">{c.customer}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(c.total_transaction_price)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(c.recognized)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(deferred)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>{t(`status.${c.status}`)}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/revenue" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openContract ? <ContractDrawer payload={openContract} canRun={canRun} /> : null}
    </ListPageLayout>
  )
}
