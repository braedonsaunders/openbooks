import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { parseListParams, pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { money } from '../../../lib/format'
import { loadOrder } from '../../api/_order/lib'
import { OrderDrawer } from '../_order/OrderDrawer'
import { NewOrderButton } from '../_order/NewOrderButton'
import { NewOrderRedirect } from '../_order/NewOrderRedirect'

export const dynamic = 'force-dynamic'

const KIND = 'purchase_order' as const
const BASE = '/purchase-orders'
const PARAM = 'order'
const API = '/api/purchase-orders'
const LABEL = 'Purchase order'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  approved: 'success',
  draft: 'secondary',
  voided: 'outline',
}
const STATUS_ORDER = ['draft', 'approved', 'voided']

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  vendor: sql`p.display_name`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

const CONVERTED_JOIN = sql`
  left join lateral (
    select coalesce(sum(l.quantity), 0) as qty,
           coalesce(sum(l.quantity_billed), 0) as billed
      from document_lines l where l.document_id = d.id
  ) cv on true`

export default async function PurchaseOrders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ap.read')
  const canManage = can(authz, 'ap.create')
  const sp = await searchParams
  const openId = typeof sp[PARAM] === 'string' ? (sp[PARAM] as string) : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'vendor', 'total', 'status'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`d.kind = ${KIND} and d.org_id = ${authz.user.orgId}
    ${status ? sql` and d.status = ${status}` : sql``}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.memo ilike ${'%' + params.q + '%'})` : sql``}`

  const [rowsRes, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.document_date, d.status, d.total,
             p.display_name as vendor,
             cv.qty, cv.billed
        from documents d
        left join parties p on p.id = d.party_id
        ${CONVERTED_JOIN}
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select d.status, count(*) as n from documents d
       where d.kind = ${KIND} and d.org_id = ${authz.user.orgId}
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

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where custom->>'nsKind' = 'vendor' and is_active order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit from items where is_active order by name limit 2000`) as any,
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
        ])
      : null,
  ])

  const statusOptions = counts.rows
    .slice()
    .sort((a: any, b: any) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    .map((r: any) => ({ value: r.status, label: String(r.status).replace('_', ' '), count: Number(r.n) }))

  const newBtn = canManage ? <NewOrderButton apiPath={API} base={BASE} param={PARAM} label={LABEL} /> : undefined

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Purchase Orders"
            description="Non-posting vendor commitments — issue, then convert into a bill on receipt."
            actions={newBtn}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search purchase orders, vendors, memo…" />
            <FilterChips basePath={BASE} currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No purchase orders yet"
          description="Create the first purchase order to start the procure-to-pay workflow."
          action={newBtn}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={BASE} currentParams={sp} column="number" sort={params.sort} dir={params.dir}>Number</SortTh>
                <SortTh basePath={BASE} currentParams={sp} column="vendor" sort={params.sort} dir={params.dir}>Vendor</SortTh>
                <SortTh basePath={BASE} currentParams={sp} column="date" sort={params.sort} dir={params.dir}>Date</SortTh>
                <SortTh basePath={BASE} currentParams={sp} column="status" sort={params.sort} dir={params.dir}>Status</SortTh>
                <TableHead className="text-right">Converted</TableHead>
                <SortTh basePath={BASE} currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">Total</SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsRes.rows.map((r: any) => {
                const qty = Number(r.qty)
                const billed = Number(r.billed)
                const pct = qty > 0 ? Math.round((billed / qty) * 100) : 0
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-[13px] font-semibold">
                      <Link href={`${BASE}?${PARAM}=${r.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {r.document_number}
                      </Link>
                    </TableCell>
                    <TableCell>{r.vendor}</TableCell>
                    <TableCell>{r.document_date}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>
                        {String(r.status).replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {qty > 0 ? `${pct}%` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath={BASE} currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openId === 'new' && canManage ? <NewOrderRedirect apiPath={API} base={BASE} param={PARAM} /> : null}
      {openOrder && pickers ? (
        <OrderDrawer
          order={openOrder as any}
          kind={KIND}
          parties={pickers[0].rows}
          accounts={pickers[1].rows}
          items={pickers[2].rows}
          taxCodes={pickers[3].rows}
          departments={pickers[4].rows}
          projects={pickers[5].rows}
          canManage={canManage}
        />
      ) : null}
    </ListPageLayout>
  )
}
