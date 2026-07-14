import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { money } from '../../../lib/format'
import { loadItem } from '../../api/items/_lib'
import { NewItemButton } from './NewItemButton'
import { NewItemRedirect } from './NewItemRedirect'
import { ItemDrawer } from './ItemDrawer'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`i.name`,
  code: sql`i.code`,
  rate: sql`i.default_rate`,
} as const

const ITEM_KINDS = [
  'service',
  'non_inventory',
  'inventory',
  'assembly',
  'kit',
  'other_charge',
  'labor',
  'absence',
  'discount',
] as const

const KIND_LABELS: Record<string, string> = {
  service: 'Service',
  non_inventory: 'Non-inventory',
  inventory: 'Inventory',
  assembly: 'Assembly',
  kit: 'Kit',
  other_charge: 'Other charge',
  labor: 'Labor',
  absence: 'Absence',
  discount: 'Discount',
}

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('items.read')
  const canManage = can(authz, 'items.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const itemId = typeof sp.item === 'string' ? sp.item : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'code', 'rate'] as const,
  })
  const kindParam = pickString(sp.kind)
  const kind = kindParam && (ITEM_KINDS as readonly string[]).includes(kindParam) ? kindParam : undefined
  const statusParam = pickString(sp.status)
  const status = statusParam === 'active' || statusParam === 'inactive' ? statusParam : undefined

  const where = sql`i.org_id = ${orgId}
    ${
      params.q
        ? sql` and (i.name ilike ${'%' + params.q + '%'} or i.code ilike ${'%' + params.q + '%'} or i.category ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${kind ? sql` and i.kind = ${kind}` : sql``}
    ${status === 'active' ? sql` and i.is_active` : status === 'inactive' ? sql` and not i.is_active` : sql``}`

  const [items, counts] = await Promise.all([
    db.execute(sql`
      select i.id, i.code, i.name, i.kind, i.category, i.default_rate, i.unit, i.is_active
        from items i
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total,
             count(*) filter (where i.is_active) as active,
             count(*) filter (where not i.is_active) as inactive,
             i.kind, count(*) as kind_count
        from items i
       where i.org_id = ${orgId}
       group by rollup (i.kind)
    `) as any,
  ])

  // rollup: the grand-total row has kind = null; per-kind rows carry a kind.
  const grand = counts.rows.find((r: any) => r.kind === null) ?? { total: 0, active: 0, inactive: 0 }
  const kindCounts = new Map<string, number>()
  for (const r of counts.rows as any[]) {
    if (r.kind !== null) kindCounts.set(r.kind, Number(r.kind_count))
  }
  const total = Number(grand.total)
  const filteredTotal =
    params.q || kind || status
      ? Number(((await db.execute(sql`select count(*) as n from items i where ${where}`)) as any).rows[0].n)
      : total

  const [openItem, pickers] = await Promise.all([
    itemId && itemId !== 'new' && isUuid(itemId) ? loadItem(itemId, orgId) : null,
    itemId
      ? Promise.all([
          db.execute(
            sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last`,
          ) as any,
          db.execute(
            sql`select id, code, name from tax_codes where org_id = ${orgId} and is_active order by code`,
          ) as any,
          loadFieldDefs('items'),
        ])
      : null,
  ])

  const kindOptions = (ITEM_KINDS as readonly string[]).map((k) => ({
    value: k,
    label: KIND_LABELS[k] ?? k,
    count: kindCounts.get(k) ?? 0,
  }))
  const statusOptions = [
    { value: 'active', label: 'Active', count: Number(grand.active) },
    { value: 'inactive', label: 'Inactive', count: Number(grand.inactive) },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Items & Services"
            description="The catalog behind every document line — services, labor, charges, and discounts."
            actions={canManage ? <NewItemButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, code, category…" />
            <FilterChips basePath="/items" currentParams={sp} paramKey="kind" label="Kind" options={kindOptions} />
            <FilterChips basePath="/items" currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No items yet"
          description="Add the first service, labor, or charge to start the catalog."
          action={canManage ? <NewItemButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/items" currentParams={sp} column="code" sort={params.sort} dir={params.dir}>Code</SortTh>
                <SortTh basePath="/items" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>Name</SortTh>
                <TableHead>Kind</TableHead>
                <TableHead>Category</TableHead>
                <SortTh basePath="/items" currentParams={sp} column="rate" sort={params.sort} dir={params.dir} align="right" className="text-right">Default rate</SortTh>
                <TableHead>Unit</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.rows.map((i: any) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-[13px]">{i.code}</TableCell>
                  <TableCell className="font-semibold">
                    <Link href={`/items?item=${i.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {i.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{KIND_LABELS[i.kind] ?? i.kind}</Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{i.category}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(i.default_rate)}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{i.unit}</TableCell>
                  <TableCell>
                    <Badge variant={i.is_active ? 'success' : 'outline'}>{i.is_active ? 'Active' : 'Inactive'}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/items" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {itemId === 'new' && canManage ? <NewItemRedirect /> : null}
      {openItem && pickers ? (
        <ItemDrawer
          key={String(openItem.item.id)}
          payload={openItem as any}
          accounts={pickers[0].rows}
          taxCodes={pickers[1].rows}
          fieldDefs={pickers[2] as any}
          canManage={canManage}
        />
      ) : null}
    </ListPageLayout>
  )
}
