import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { requirePermission } from '../../../lib/authz'
import { money } from '../../../lib/format'
import { InvoiceActions } from './InvoiceActions'
import { InvoiceDrawer } from './InvoiceDrawer'
import { NewInvoiceButton } from './NewInvoiceButton'
import { loadInvoice } from '../../../lib/invoices'
import { loadFieldDefs } from '../../../lib/custom-fields'

export const dynamic = 'force-dynamic'

/** Posted invoices resolve to open/paid buckets from the applications ledger. */
const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'default',
  paid: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'open', 'paid', 'voided']

/** DB status/bucket value → `common.status.*` message key. Unknown values render verbatim. */
const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  open: 'open',
  paid: 'paid',
  voided: 'voided',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  customer: sql`p.display_name`,
  total: sql`d.total`,
  balance: sql`case when d.status = 'posted' then d.total - ap.applied end`,
  status: sql`d.status`,
} as const

/** Sum of un-reversed applications against the posted entry's AR open item. */
const APPLIED_JOIN = sql`
  left join lateral (
    select coalesce(sum(a.amount), 0) as applied
      from journal_lines jl
      join applications a on a.to_line_id = jl.id and a.unapplied_at is null
     where jl.entry_id = d.posted_entry_id and jl.is_open_item
  ) ap on true`

export default async function AR({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('ar.read')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')
  const statusLabel = (bucket: string) =>
    STATUS_KEYS[bucket] ? tCommon(`status.${STATUS_KEYS[bucket]}`) : bucket.replace('_', ' ')
  const sp = await searchParams
  const invoiceId = typeof sp.invoice === 'string' ? sp.invoice : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'customer', 'total', 'balance', 'status'] as const,
  })
  const status = pickString(sp.status)

  const statusFilter =
    status === 'open'
      ? sql` and d.status = 'posted' and ap.applied < d.total`
      : status === 'paid'
        ? sql` and d.status = 'posted' and ap.applied >= d.total`
        : status
          ? sql` and d.status = ${status}`
          : sql``
  const where = sql`d.kind = 'customer_invoice'
    ${statusFilter}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.reference_number ilike ${'%' + params.q + '%'})` : sql``}`

  const [invoices, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.document_date, d.status, d.total,
             d.reference_number, p.display_name as customer, e.id as entry_id,
             case when d.status = 'posted' then d.total - ap.applied end as balance,
             case when d.status = 'posted'
                  then case when ap.applied >= d.total then 'paid' else 'open' end
                  else d.status end as bucket
        from documents d
        left join parties p on p.id = d.party_id
        left join journal_entries e on e.id = d.posted_entry_id
        ${APPLIED_JOIN}
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select case when d.status = 'posted'
                  then case when ap.applied >= d.total then 'paid' else 'open' end
                  else d.status end as bucket,
             count(*) as n
        from documents d
        ${APPLIED_JOIN}
       where d.kind = 'customer_invoice'
       group by 1
    `) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = status || params.q
    ? Number(((await db.execute(sql`
        select count(*) as n from documents d
          left join parties p on p.id = d.party_id
          ${APPLIED_JOIN}
         where ${where}`)) as any).rows[0].n)
    : total

  const [openInvoice, pickers] = await Promise.all([
    invoiceId ? loadInvoice(invoiceId) : null,
    invoiceId
      ? Promise.all([
          db.execute(sql`
            select id, display_name from parties
             where (custom->>'nsKind' = 'customer'
                    or exists (select 1 from customer_roles cr where cr.party_id = parties.id))
               and is_active
             order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where type in ('income','income_other') and is_active and not is_summary order by number nulls last`) as any,
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
          loadFieldDefs('documents', 'customer_invoice'),
          loadFieldDefs('document_lines', 'customer_invoice'),
        ])
      : null,
  ])

  const statusOptions = counts.rows
    .slice()
    .sort((a: any, b: any) => STATUS_ORDER.indexOf(a.bucket) - STATUS_ORDER.indexOf(b.bucket))
    .map((r: any) => ({
      value: r.bucket,
      label: statusLabel(String(r.bucket)),
      count: Number(r.n),
    }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={<NewInvoiceButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/ar" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={<NewInvoiceButton />}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/ar" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('list.columns.invoice')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="customer" sort={params.sort} dir={params.dir}>{tCommon('labels.customer')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{tCommon('labels.date')}</SortTh>
                <TableHead>{t('list.columns.ref')}</TableHead>
                <SortTh basePath="/ar" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.total')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="balance" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.balance')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tCommon('labels.status')}</SortTh>
                <TableHead>{tCommon('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.rows.map((inv: any) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link href={`/ar?invoice=${inv.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {inv.document_number}
                    </Link>
                  </TableCell>
                  <TableCell>{inv.customer}</TableCell>
                  <TableCell>{inv.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{inv.reference_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(inv.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {inv.balance == null ? (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    ) : (
                      money(inv.balance)
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[inv.bucket] ?? 'secondary'}>
                      {statusLabel(String(inv.bucket))}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <InvoiceActions id={inv.id} status={inv.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/ar" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openInvoice && pickers ? (
        <InvoiceDrawer
          invoice={openInvoice as any}
          customers={pickers[0].rows}
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
