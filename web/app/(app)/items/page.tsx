import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { ShowInactivesToggle } from '../../../components/show-inactives-toggle'
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

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('items'), getTranslations('common')])
  const kindLabel = (k: string) =>
    (ITEM_KINDS as readonly string[]).includes(k) ? t(`kinds.${k}`) : k

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
  const showInactive = pickString(sp.showInactive) === 'true'

  const where = sql`i.org_id = ${orgId}
    ${
      params.q
        ? sql` and (i.name ilike ${'%' + params.q + '%'} or i.code ilike ${'%' + params.q + '%'} or i.category ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${kind ? sql` and i.kind = ${kind}` : sql``}
    ${showInactive ? sql`` : sql` and i.is_active`}`

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
       where i.org_id = ${orgId} ${showInactive ? sql`` : sql`and i.is_active`}
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
    params.q || kind
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
    label: kindLabel(k),
    count: kindCounts.get(k) ?? 0,
  }))
  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canManage ? <NewItemButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/items" currentParams={sp} paramKey="kind" label={t('list.kindFilter')} options={kindOptions} />
            <ShowInactivesToggle basePath="/items" currentParams={sp} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={canManage ? <NewItemButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/items" currentParams={sp} column="code" sort={params.sort} dir={params.dir}>{t('labels.code')}</SortTh>
                <SortTh basePath="/items" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{tCommon('labels.name')}</SortTh>
                <TableHead>{t('labels.kind')}</TableHead>
                <TableHead>{t('labels.category')}</TableHead>
                <SortTh basePath="/items" currentParams={sp} column="rate" sort={params.sort} dir={params.dir} align="right" className="text-right">{t('labels.defaultRate')}</SortTh>
                <TableHead>{t('labels.unit')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
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
                    <Badge variant="secondary">{kindLabel(i.kind)}</Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{i.category}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(i.default_rate)}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{i.unit}</TableCell>
                  <TableCell>
                    <Badge variant={i.is_active ? 'success' : 'outline'}>
                      {i.is_active ? tCommon('status.active') : tCommon('status.inactive')}
                    </Badge>
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
