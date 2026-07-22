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
import { loadAsset } from '../../api/assets/_lib'
import { NewAssetButton } from './NewAssetButton'
import { NewAssetRedirect } from './NewAssetRedirect'
import { RunDepreciationButton } from './RunDepreciationButton'
import { AssetDrawer } from './AssetDrawer'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  number: sql`a.asset_number`,
  name: sql`a.name`,
  cost: sql`a.acquisition_cost`,
} as const

const STATUS_VALUES = ['draft', 'in_service', 'fully_depreciated', 'disposed', 'written_off'] as const

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  in_service: 'success',
  fully_depreciated: 'secondary',
  draft: 'outline',
  disposed: 'warning',
  written_off: 'warning',
}

export default async function Assets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('assets'), getTranslations('common')])

  const authz = await requirePermission('assets.read')
  const canManage = can(authz, 'assets.manage')
  const orgId = authz.user.orgId
  const [multiSub, allSubsidiaries] = await Promise.all([isMultiSubsidiary(), subsidiaryOptions()])
  const subsidiaries = authz.allowedSubsidiaryIds
    ? allSubsidiaries.filter((subsidiary) => authz.allowedSubsidiaryIds!.has(subsidiary.id))
    : allSubsidiaries
  const allowedSubsidiaries = authz.allowedSubsidiaryIds
    ? sql`and a.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])`
    : sql``

  const sp = await searchParams
  const assetId = typeof sp.asset === 'string' ? sp.asset : undefined
  const params = parseListParams(sp, {
    sort: 'number',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['number', 'name', 'cost'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam && (STATUS_VALUES as readonly string[]).includes(statusParam) ? statusParam : undefined

  const where = sql`a.org_id = ${orgId}
    ${allowedSubsidiaries}
    ${
      params.q
        ? sql` and (a.name ilike ${'%' + params.q + '%'} or a.asset_number ilike ${'%' + params.q + '%'} or a.serial_number ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${status ? sql` and a.status = ${status}` : sql``}`

  // Accumulated depreciation = sum of posted depreciation lines per asset.
  const [assets, counts] = await Promise.all([
    db.execute(sql`
      select a.id, a.asset_number, a.name, a.status, a.acquisition_cost,
             c.name as category_name,
             coalesce((
               select sum(l.posted_amount)
                 from depreciation_schedules s
                 join depreciation_schedule_lines l on l.schedule_id = s.id
                where s.asset_id = a.id and l.posted_amount is not null
             ), 0) as accumulated
        from fixed_assets a
        left join asset_categories c on c.id = a.category_id
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total, a.status, count(*) as status_count
        from fixed_assets a
       where a.org_id = ${orgId} ${allowedSubsidiaries}
       group by rollup (a.status)
    `) as any,
  ])

  const grand = counts.rows.find((r: any) => r.status === null) ?? { total: 0 }
  const statusCounts = new Map<string, number>()
  for (const r of counts.rows as any[]) if (r.status !== null) statusCounts.set(r.status, Number(r.status_count))
  const total = Number(grand.total)
  const filteredTotal =
    params.q || status
      ? Number(((await db.execute(sql`select count(*) as n from fixed_assets a where ${where}`)) as any).rows[0].n)
      : total

  const [openAsset, pickers] = await Promise.all([
    assetId && assetId !== 'new' && isUuid(assetId) ? loadAsset(assetId, orgId) : null,
    assetId
      ? Promise.all([
          db.execute(sql`select id, name from asset_categories where org_id = ${orgId} and is_active order by name`) as any,
          db.execute(
            sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last`,
          ) as any,
        ])
      : null,
  ])

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
            actions={
              <div className="flex items-center gap-2">
                <Link href="/docs/fixed-assets-depreciation" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
                  {t('equipment.documentation')}
                </Link>
                {canManage ? (
                  <>
                  <RunDepreciationButton />
                  <NewAssetButton />
                  </>
                ) : null}
              </div>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/assets/equipment" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
              {t('equipment.title')}
            </Link>
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/assets" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={canManage ? <NewAssetButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/assets" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>
                  {t('labels.number')}
                </SortTh>
                <SortTh basePath="/assets" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                  {tCommon('labels.name')}
                </SortTh>
                <TableHead>{t('labels.category')}</TableHead>
                <SortTh basePath="/assets" currentParams={sp} column="cost" sort={params.sort} dir={params.dir} align="right" className="text-right">
                  {t('labels.cost')}
                </SortTh>
                <TableHead className="text-right">{t('labels.accumulated')}</TableHead>
                <TableHead className="text-right">{t('labels.nbv')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.rows.map((a: any) => {
                const nbv = Number(a.acquisition_cost ?? 0) - Number(a.accumulated ?? 0)
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-[13px]">{a.asset_number}</TableCell>
                    <TableCell className="font-semibold">
                      <Link href={`/assets?asset=${a.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">{a.category_name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(a.acquisition_cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(a.accumulated)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(nbv)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[a.status] ?? 'secondary'}>{t(`status.${a.status}`)}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/assets" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {assetId === 'new' && canManage ? <NewAssetRedirect /> : null}
      {openAsset && pickers && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(openAsset.asset.subsidiary_id))) ? (
        <AssetDrawer
          key={String(openAsset.asset.id)}
          payload={openAsset}
          categories={pickers[0].rows}
          accounts={pickers[1].rows}
          subsidiaries={multiSub ? subsidiaries : []}
          canManage={canManage}
        />
      ) : null}
    </ListPageLayout>
  )
}
