import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { KpiStrip } from '../../../../components/kpi-strip'
import { can, requirePermission } from '../../../../lib/authz'
import { buildListDrawerHref, isUuid, parseListParams, pickString } from '../../../../lib/list-params'
import { loadEquipment } from '../../../api/equipment/_lib'
import { NewEquipmentButton } from './NewEquipmentButton'
import { EquipmentDrawer } from './EquipmentDrawer'
import { subsidiaryFeatureEnabled } from '../../../../lib/features'

export const dynamic = 'force-dynamic'
const STATUSES = ['draft','active','inactive','retired'] as const
const SORT = { number: sql`e.unit_number`, name: sql`e.name`, purchase: sql`e.purchase_price`, recovery: sql`recovery` } as const
export default async function EquipmentPage({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { money } = await getMoneyFormatter()
  const [t, common] = await Promise.all([getTranslations('assets.equipment'), getTranslations('common')])
  const authz = await requirePermission('assets.read'); const canManage = can(authz,'assets.manage'); const sp = await searchParams
  const params = parseListParams(sp,{sort:'number',dir:'asc',perPage:25,allowedSorts:['number','name','purchase','recovery'] as const})
  const statusRaw = pickString(sp.status); const status = statusRaw && STATUSES.includes(statusRaw as any) ? statusRaw : undefined
  const equipmentId = typeof sp.equipment === 'string' ? sp.equipment : undefined
  const allowed = authz.allowedSubsidiaryIds ? sql`and e.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``
  const where = sql`e.org_id=${authz.user.orgId} ${allowed} ${status ? sql`and e.status=${status}` : sql``} ${params.q ? sql`and (e.name ilike ${'%'+params.q+'%'} or e.unit_number ilike ${'%'+params.q+'%'} or e.serial_number ilike ${'%'+params.q+'%'})` : sql``}`
  const [rows,total,summary,open,pickers,subsidiaryUiEnabled] = await Promise.all([
    db.execute(sql`select e.*,i.name as item_name,coalesce(sum(dl.cost_amount) filter(where d.status in ('approved','posted')),0) as recovery,
      coalesce(sum(dl.bill_amount) filter(where d.status in ('approved','posted')),0) as billable from equipment_units e left join items i on i.id=e.charge_item_id
      left join document_lines dl on dl.equipment_unit_id=e.id left join documents d on d.id=dl.document_id and d.kind='project_charge'
      where ${where} group by e.id,i.name order by ${SORT[params.sort]} ${params.dir==='asc'?sql`asc`:sql`desc`} nulls last limit ${params.perPage} offset ${(params.page-1)*params.perPage}`) as any,
    db.execute(sql`select count(*)::int n from equipment_units e where ${where}`) as any,
    db.execute(sql`
      select coalesce(sum(e.purchase_price),0) purchase,
             count(*) filter(where e.status='active') active,
             coalesce(sum((select sum(dl.cost_amount) from document_lines dl join documents d on d.id=dl.document_id
               where dl.equipment_unit_id=e.id and d.kind='project_charge' and d.status in ('approved','posted'))),0) recovery,
             coalesce(sum((select sum(dl.bill_amount) from document_lines dl join documents d on d.id=dl.document_id
               where dl.equipment_unit_id=e.id and d.kind='project_charge' and d.status in ('approved','posted'))),0) billable
        from equipment_units e where e.org_id=${authz.user.orgId} ${allowed}
    `) as any,
    equipmentId && isUuid(equipmentId) ? loadEquipment(equipmentId,authz.user.orgId) : null,
    equipmentId ? Promise.all([
      db.execute(sql`select id,code,name from items where org_id=${authz.user.orgId} and kind='equipment_charge' and is_active order by name`) as any,
      db.execute(sql`select id,asset_number as number,name from fixed_assets where org_id=${authz.user.orgId} ${authz.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``} order by asset_number`) as any,
      db.execute(sql`select id,code,name from item_rate_books where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,name from subsidiaries where org_id=${authz.user.orgId} and is_active and not is_elimination ${authz.allowedSubsidiaryIds ? sql`and id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``} order by name`) as any,
    ]) : null,
    subsidiaryFeatureEnabled(authz.user.orgId),
  ])
  return <ListPageLayout header={<><PageHeader title={t('title')} description={t('pageDescription')} actions={canManage?<NewEquipmentButton/>:undefined}/><div className="flex flex-wrap items-center gap-2"><Link href="/assets" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('fixedAssets')}</Link><Link href="/assets?tab=tax-depreciation" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('taxDepreciation')}</Link><Link href="/docs/item-rates" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('documentation')}</Link><SearchInput placeholder={t('search')}/><FilterChips basePath="/assets/equipment" currentParams={sp} paramKey="status" label={common('labels.status')} options={STATUSES.map(s=>({value:s,label:t(`statuses.${s}`)}))}/></div></>}>
    <div className="space-y-5"><KpiStrip items={[{label:t('metrics.active'),value:String(summary.rows[0]?.active??0)},{label:t('metrics.purchaseBasis'),value:money(summary.rows[0]?.purchase)},{label:t('metrics.recovery'),value:money(summary.rows[0]?.recovery)},{label:t('metrics.billable'),value:money(summary.rows[0]?.billable)}]}/>
    {Number(total.rows[0]?.n??0)===0?<EmptyState title={t('empty')} description={t('emptyDescription')} action={canManage?<NewEquipmentButton/>:undefined}/>:<><Table><TableHeader><TableRow><SortTh basePath="/assets/equipment" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('number')}</SortTh><SortTh basePath="/assets/equipment" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{common('labels.name')}</SortTh><TableHead>{t('chargeItem')}</TableHead><SortTh basePath="/assets/equipment" currentParams={sp} column="purchase" sort={params.sort} dir={params.dir} align="right">{t('purchasePrice')}</SortTh><SortTh basePath="/assets/equipment" currentParams={sp} column="recovery" sort={params.sort} dir={params.dir} align="right">{t('metrics.recovery')}</SortTh><TableHead className="text-right">{t('metrics.billable')}</TableHead><TableHead>{common('labels.status')}</TableHead></TableRow></TableHeader><TableBody>{rows.rows.map((e:any)=><TableRow key={e.id}><TableCell className="font-mono text-xs">{e.unit_number}</TableCell><TableCell><Link href={buildListDrawerHref('/assets/equipment', sp, 'equipment', String(e.id)) as any} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{e.name}</Link></TableCell><TableCell>{e.item_name??'—'}</TableCell><TableCell className="text-right tabular-nums">{money(e.purchase_price)}</TableCell><TableCell className="text-right tabular-nums">{money(e.recovery)}</TableCell><TableCell className="text-right tabular-nums">{money(e.billable)}</TableCell><TableCell><Badge variant={e.status==='active'?'success':'secondary'}>{t(`statuses.${e.status}`)}</Badge></TableCell></TableRow>)}</TableBody></Table><Pagination basePath="/assets/equipment" currentParams={sp} total={Number(total.rows[0]?.n??0)} page={params.page} perPage={params.perPage}/></>}
    </div>{open&&pickers&&(!authz.allowedSubsidiaryIds||authz.allowedSubsidiaryIds.has(String(open.unit.subsidiary_id)))?<EquipmentDrawer payload={open} items={pickers[0].rows} assets={pickers[1].rows} books={pickers[2].rows} subsidiaries={subsidiaryUiEnabled ? pickers[3].rows : []} canManage={canManage}/>:null}
  </ListPageLayout>
}
