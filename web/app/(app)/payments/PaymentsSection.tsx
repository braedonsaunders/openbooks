import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  openItemsForParty,
  PAYMENT_KIND_SIDE,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentDrawer, type OpenItemClient } from './PaymentDrawer'

/**
 * Server-rendered payment/receipt document list + flyout, shared by
 * /payments (vendor_payment) and /receipts (customer_payment). The page owns
 * the header; this owns filters, table, pagination, and the ?payment= drawer.
 */

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  draft: 'secondary',
  voided: 'outline',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  party: sql`p.display_name`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

export async function PaymentsSection({
  sp,
  basePath,
  kind,
  orgId,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath: string
  kind: PaymentKind
  orgId: string
}) {
  const side = PAYMENT_KIND_SIDE[kind]
  const partyLabel = side === 'ap' ? 'Vendor' : 'Customer'
  const newLabel = side === 'ap' ? 'New payment' : 'New receipt'

  const paymentId = typeof sp.payment === 'string' && isUuid(sp.payment) ? sp.payment : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'party', 'total', 'status'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`d.org_id = ${orgId} and d.kind = ${kind}
    ${status ? sql` and d.status = ${status}` : sql``}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.reference_number ilike ${'%' + params.q + '%'})` : sql``}`

  const [payments, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.document_date, d.status, d.total, d.reference_number,
             p.display_name as party, a.number as bank_number, a.name as bank_name
        from documents d
        left join parties p on p.id = d.party_id
        left join accounts a on a.id = (d.custom->>'bankAccountId')::uuid
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select d.status, count(*) as n from documents d
       where d.org_id = ${orgId} and d.kind = ${kind} group by d.status
    `) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal =
    status || params.q
      ? Number(
          (
            (await db.execute(sql`
              select count(*) as n from documents d
                left join parties p on p.id = d.party_id
               where ${where}`)) as any
          ).rows[0].n,
        )
      : total

  // -- flyout ---------------------------------------------------------------
  const loaded = paymentId ? await loadPaymentDocument(paymentId, kind) : null
  const openPayment = loaded && loaded.doc.org_id === orgId ? loaded : null
  let drawer: React.ReactNode = null
  if (openPayment) {
    const partyFilter =
      side === 'ap'
        ? sql`(exists (select 1 from vendor_roles vr where vr.party_id = p.id) or p.custom->>'nsKind' = 'vendor')`
        : sql`(exists (select 1 from customer_roles cr where cr.party_id = p.id) or p.custom->>'nsKind' = 'customer')`
    const [parties, banks] = await Promise.all([
      db.execute(sql`
        select id, display_name from parties p
         where p.org_id = ${orgId} and ${partyFilter} and is_active
         order by display_name limit 2000`) as any,
      db.execute(sql`
        select id, number, name from accounts
         where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
         order by number nulls last, name`) as any,
    ])
    const openItems: OpenItemClient[] =
      openPayment.doc.status === 'draft' && openPayment.doc.party_id
        ? await openItemsForParty(openPayment.doc.party_id as string, side)
        : []
    drawer = (
      <PaymentDrawer
        payment={openPayment as any}
        initialOpenItems={openItems}
        parties={parties.rows}
        bankAccounts={banks.rows}
        side={side}
        basePath={basePath}
      />
    )
  }

  const statusOptions = counts.rows.map((r: any) => ({
    value: r.status,
    label: String(r.status).replace('_', ' '),
    count: Number(r.n),
  }))

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={`Search ${side === 'ap' ? 'payments' : 'receipts'}, ${partyLabel.toLowerCase()}s, refs…`} />
        <FilterChips basePath={basePath} currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
      </div>
      {total === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={side === 'ap' ? 'No payments yet' : 'No receipts yet'}
            description={
              side === 'ap'
                ? 'Record the first vendor payment to start settling open bills.'
                : 'Record the first customer receipt to start settling open invoices.'
            }
            action={<NewPaymentButton kind={kind} basePath={basePath} label={newLabel} />}
          />
        </div>
      ) : (
        <div className="mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={basePath} currentParams={sp} column="number" sort={params.sort} dir={params.dir}>
                  {side === 'ap' ? 'Payment' : 'Receipt'}
                </SortTh>
                <SortTh basePath={basePath} currentParams={sp} column="party" sort={params.sort} dir={params.dir}>
                  {partyLabel}
                </SortTh>
                <SortTh basePath={basePath} currentParams={sp} column="date" sort={params.sort} dir={params.dir}>
                  Date
                </SortTh>
                <TableHead>Bank account</TableHead>
                <TableHead>Ref</TableHead>
                <SortTh basePath={basePath} currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">
                  Total
                </SortTh>
                <SortTh basePath={basePath} currentParams={sp} column="status" sort={params.sort} dir={params.dir}>
                  Status
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.rows.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link
                      href={`${basePath}?payment=${p.id}` as any}
                      className="text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {p.document_number}
                    </Link>
                  </TableCell>
                  <TableCell>{p.party ?? '—'}</TableCell>
                  <TableCell>{p.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {`${p.bank_number ?? ''} ${p.bank_name ?? ''}`.trim() || '—'}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.reference_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.total)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'secondary'}>
                      {String(p.status).replace('_', ' ')}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath={basePath} currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </div>
      )}
      {drawer}
    </>
  )
}
