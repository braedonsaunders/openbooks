import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { requirePermission } from '../../../lib/authz'
import { BillActions } from './BillActions'
import { BillDrawer } from './BillDrawer'
import { NewBillButton } from './NewBillButton'
import { loadBill } from '../../../lib/bills'
import { loadFieldDefs } from '../../../lib/custom-fields'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// documents.status enum → common.status.* message keys (fallback: raw value).
const STATUS_LABEL_KEY: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  rejected: 'rejected',
  posted: 'posted',
  paid: 'paid',
  partially_paid: 'partiallyPaid',
  voided: 'voided',
  reversed: 'reversed',
  cancelled: 'cancelled',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  vendor: sql`p.display_name`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

export default async function AP({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('ap.read')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }
  const sp = await searchParams
  const billId = typeof sp.bill === 'string' ? sp.bill : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'vendor', 'total', 'status'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`d.kind = 'vendor_bill'
    ${status ? sql` and d.status = ${status}` : sql``}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.reference_number ilike ${'%' + params.q + '%'})` : sql``}`

  const [bills, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.document_date, d.status, d.total,
             d.reference_number, p.display_name as vendor, e.id as entry_id
        from documents d
        left join parties p on p.id = d.party_id
        left join journal_entries e on e.id = d.posted_entry_id
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select d.status, count(*) as n from documents d
        left join parties p on p.id = d.party_id
       where d.kind = 'vendor_bill'
       group by d.status
    `) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = status || params.q
    ? Number(((await db.execute(sql`
        select count(*) as n from documents d
          left join parties p on p.id = d.party_id
         where ${where}`)) as any).rows[0].n)
    : total

  const [openBill, pickers] = await Promise.all([
    billId ? loadBill(billId) : null,
    billId
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where custom->>'nsKind' = 'vendor' and is_active order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`
            select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
              from tax_codes tc
              left join lateral (
                select rate_percent from tax_rates
                 where tax_code_id = tc.id and effective_from <= now()
                 order by effective_from desc limit 1) tr on true
             where tc.is_active order by tc.code`) as any,
          db.execute(sql`select id, name from departments where is_active order by name`) as any,
          db.execute(sql`select id, name from projects where is_active order by name limit 2000`) as any,
          loadFieldDefs('documents', 'vendor_bill'),
          loadFieldDefs('document_lines', 'vendor_bill'),
        ])
      : null,
  ])

  const statusOptions = counts.rows.map((r: any) => ({
    value: r.status,
    label: statusLabel(String(r.status)),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={<NewBillButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/ap" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.empty.title')}
          description={t('list.empty.description')}
          action={<NewBillButton />}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/ap" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('list.columns.bill')}</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="vendor" sort={params.sort} dir={params.dir}>{tCommon('labels.vendor')}</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{tCommon('labels.date')}</SortTh>
                <TableHead>{t('list.columns.ref')}</TableHead>
                <SortTh basePath="/ap" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.total')}</SortTh>
                <SortTh basePath="/ap" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tCommon('labels.status')}</SortTh>
                <TableHead>{tCommon('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.rows.map((b: any) => (
                <TableRow key={b.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link href={`/ap?bill=${b.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {b.document_number}
                    </Link>
                  </TableCell>
                  <TableCell>{b.vendor}</TableCell>
                  <TableCell>{b.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{b.reference_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(b.total)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[b.status] ?? 'secondary'}>
                      {statusLabel(String(b.status))}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <BillActions id={b.id} status={b.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/ap" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openBill && pickers ? (
        <BillDrawer
          bill={openBill as any}
          vendors={pickers[0].rows}
          accounts={pickers[1].rows}
          taxCodes={pickers[2].rows}
          departments={pickers[3].rows}
          projects={pickers[4].rows}
          headerDefs={pickers[5] as any}
          lineDefs={pickers[6] as any}
        />
      ) : null}
    </ListPageLayout>
  )
}
