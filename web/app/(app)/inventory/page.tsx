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
import { can, requirePermission } from '../../../lib/authz'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { NewMovementButton } from './NewMovementButton'
import { InventoryActionDrawer } from './InventoryActionDrawer'

export const dynamic = 'force-dynamic'

const MOVEMENT_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  receipt: 'success',
  issue: 'warning',
  adjustment: 'secondary',
  transfer_in: 'outline',
  transfer_out: 'outline',
  count: 'secondary',
  return: 'outline',
}

export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('inventory'), getTranslations('common')])

  const authz = await requirePermission('items.read')
  const canManage = can(authz, 'items.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const view = pickString(sp.view) === 'movements' ? 'movements' : 'onhand'
  const showDrawer = pickString(sp.movement) === 'new'
  const params = parseListParams(sp, { sort: 'name', dir: 'asc', perPage: 25, allowedSorts: ['name'] as const })

  const viewOptions = [
    { value: 'onhand', label: t('view.onhand'), count: 0 },
    { value: 'movements', label: t('view.movements'), count: 0 },
  ]

  // -- on-hand valuation ----------------------------------------------------
  let onhand: any = { rows: [] }
  let onhandTotal = 0
  let movements: any = { rows: [] }
  let movementsTotal = 0

  if (view === 'onhand') {
    const where = sql`cl.org_id = ${orgId} and cl.remaining_quantity > 0
      ${params.q ? sql` and (it.name ilike ${'%' + params.q + '%'} or it.code ilike ${'%' + params.q + '%'} or sl.code ilike ${'%' + params.q + '%'})` : sql``}`
    const [rows, count] = await Promise.all([
      db.execute(sql`
        select it.id as item_id, it.name as item_name, it.code as item_code,
               sl.code as loc_code,
               sum(cl.remaining_quantity) as qty,
               sum(round(cl.remaining_quantity * cl.unit_cost, 4)) as value
          from cost_layers cl
          join items it on it.id = cl.item_id
          join stock_locations sl on sl.id = cl.stock_location_id
         where ${where}
         group by it.id, it.name, it.code, sl.code
         order by it.name asc, sl.code asc
         limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
      `) as any,
      db.execute(sql`
        select count(*) as n from (
          select 1 from cost_layers cl
            join items it on it.id = cl.item_id
            join stock_locations sl on sl.id = cl.stock_location_id
           where ${where}
           group by it.id, sl.code
        ) x`) as any,
    ])
    onhand = rows
    onhandTotal = Number(count.rows[0]?.n ?? 0)
  } else {
    const where = sql`m.org_id = ${orgId}
      ${params.q ? sql` and (it.name ilike ${'%' + params.q + '%'} or sl.code ilike ${'%' + params.q + '%'})` : sql``}`
    const [rows, count] = await Promise.all([
      db.execute(sql`
        select m.id, m.kind, m.moved_at, m.quantity, m.unit_cost, m.total_value,
               it.name as item_name, sl.code as loc_code
          from inventory_movements m
          join items it on it.id = m.item_id
          join stock_locations sl on sl.id = m.stock_location_id
         where ${where}
         order by m.moved_at desc, m.id desc
         limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
      `) as any,
      db.execute(sql`
        select count(*) as n from inventory_movements m
          join items it on it.id = m.item_id
          join stock_locations sl on sl.id = m.stock_location_id
         where ${where}`) as any,
    ])
    movements = rows
    movementsTotal = Number(count.rows[0]?.n ?? 0)
  }

  // -- drawer pickers -------------------------------------------------------
  const pickers = showDrawer && canManage
    ? await Promise.all([
        db.execute(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id
           where it.org_id = ${orgId} and it.is_active order by it.name`) as any,
        db.execute(sql`select id, code from stock_locations where org_id = ${orgId} and is_active order by code`) as any,
        db.execute(
          sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last`,
        ) as any,
      ])
    : null

  const total = view === 'onhand' ? onhandTotal : movementsTotal

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canManage ? <NewMovementButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/inventory" currentParams={sp} paramKey="view" label={t('list.view')} options={viewOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} />
      ) : view === 'onhand' ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('labels.item')}</TableHead>
                <TableHead>{t('labels.location')}</TableHead>
                <TableHead className="text-right">{t('labels.quantity')}</TableHead>
                <TableHead className="text-right">{t('labels.avgCost')}</TableHead>
                <TableHead className="text-right">{t('labels.value')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {onhand.rows.map((r: any, i: number) => {
                const avg = Number(r.qty) !== 0 ? Number(r.value) / Number(r.qty) : 0
                return (
                  <TableRow key={i}>
                    <TableCell className="font-semibold">
                      {r.item_code ? <span className="font-mono text-xs text-slate-500">{r.item_code} · </span> : null}
                      {r.item_name}
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">{r.loc_code}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.qty).toFixed(4)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(avg.toFixed(4))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.value)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/inventory" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </div>
        </>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('labels.date')}</TableHead>
                <TableHead>{t('labels.kind')}</TableHead>
                <TableHead>{t('labels.item')}</TableHead>
                <TableHead>{t('labels.location')}</TableHead>
                <TableHead className="text-right">{t('labels.quantity')}</TableHead>
                <TableHead className="text-right">{t('labels.value')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.rows.map((m: any) => (
                <TableRow key={m.id}>
                  <TableCell className="tabular-nums">{String(m.moved_at).slice(0, 10)}</TableCell>
                  <TableCell>
                    <Badge variant={MOVEMENT_VARIANT[m.kind] ?? 'secondary'}>{t(`kind.${m.kind}`)}</Badge>
                  </TableCell>
                  <TableCell className="font-semibold">{m.item_name}</TableCell>
                  <TableCell className="font-mono text-[13px]">{m.loc_code}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(m.quantity).toFixed(4)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.total_value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/inventory" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {showDrawer && pickers ? (
        <InventoryActionDrawer
          items={pickers[0].rows}
          stockLocations={pickers[1].rows}
          accounts={pickers[2].rows}
        />
      ) : null}
    </ListPageLayout>
  )
}
