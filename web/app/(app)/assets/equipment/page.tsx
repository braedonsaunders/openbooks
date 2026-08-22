import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { EntityListView } from '../../../../components/entity-list-view'
import { KpiStrip } from '../../../../components/kpi-strip'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadEquipment } from '../../../api/equipment/_lib'
import { NewEquipmentButton } from './NewEquipmentButton'
import { EquipmentDrawer } from './EquipmentDrawer'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'

export const dynamic = 'force-dynamic'
export default async function EquipmentPage({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('assets.equipment')
  const authz = await requirePermission('assets.read')
  await requireFeatureEnabled(authz.user.orgId, 'equipment')
   const canManage = can(authz,'assets.manage'); const sp = await searchParams
  const equipmentId = typeof sp.equipment === 'string' ? sp.equipment : undefined
  const allowed = authz.allowedSubsidiaryIds ? sql`and e.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``
  const [summary,open,pickers,subsidiaryUiEnabled,fixedAssetsEnabled] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(e.purchase_price),0) purchase,
             count(*) filter(where e.status='active') active,
             coalesce(sum((select sum(dl.cost_amount) from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
               where dl.equipment_unit_id=e.id and dl.org_id=e.org_id and d.kind='project_charge' and d.status in ('approved','posted'))),0) recovery,
             coalesce(sum((select sum(dl.bill_amount) from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
               where dl.equipment_unit_id=e.id and dl.org_id=e.org_id and d.kind='project_charge' and d.status in ('approved','posted'))),0) billable
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
    isFeatureEnabled(authz.user.orgId, 'fixedAssets'),
  ])
  const requestedReturn = pickString(sp.drawerReturn)
  return <ListPageLayout header={<><PageHeader title={t('title')} description={t('pageDescription')} actions={canManage?<NewEquipmentButton/>:undefined}/><div className="flex flex-wrap items-center gap-2">{fixedAssetsEnabled ? <><Link href="/assets" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('fixedAssets')}</Link><Link href="/assets?tab=tax-depreciation" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('taxDepreciation')}</Link></> : null}<Link href="/docs/item-rates" className="text-sm text-teal-700 hover:underline dark:text-teal-300">{t('documentation')}</Link></div></>}>
    <div className="space-y-5"><KpiStrip items={[{label:t('metrics.active'),value:String(summary.rows[0]?.active??0)},{label:t('metrics.purchaseBasis'),value:money(summary.rows[0]?.purchase)},{label:t('metrics.recovery'),value:money(summary.rows[0]?.recovery)},{label:t('metrics.billable'),value:money(summary.rows[0]?.billable)}]}/>
    <EntityListView recordType="equipment_unit" orgId={authz.user.orgId} userId={authz.user.id} canManage={can(authz,'admin.customization.manage')} sp={sp} emptyAction={canManage?<NewEquipmentButton/>:undefined} drawer={open&&pickers&&(!authz.allowedSubsidiaryIds||authz.allowedSubsidiaryIds.has(String(open.unit.subsidiary_id)))?<EquipmentDrawer payload={open} items={pickers[0].rows} assets={fixedAssetsEnabled ? pickers[1].rows : []} books={pickers[2].rows} subsidiaries={subsidiaryUiEnabled ? pickers[3].rows : []} canManage={canManage} closeHref={requestedReturn?.startsWith('/assets/equipment') ? requestedReturn : '/assets/equipment'} fixedAssetsEnabled={fixedAssetsEnabled}/>:null}/>
    </div>
  </ListPageLayout>
}
