import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listStockCounts } from '@openbooks/engine/src/inventory/stock-count-queries.ts'
import { Button, PageHeader } from '@openbooks/ui'
import { Plus } from 'lucide-react'
import { EntityListView } from '../../../components/entity-list-view'
import { ListPageLayout } from '../../../components/page-layout'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { pickString } from '../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { BomWorkspace, NewBomButton, type BomAssembly } from './BomWorkspace'
import { CountsList, NewCountButton } from './counts/CountsList'
import { InventoryActionDrawer } from './InventoryActionDrawer'
import { NewMovementButton } from './NewMovementButton'
import { ReverseLandedVoucherAction } from './ReverseLandedVoucherAction'

export const dynamic = 'force-dynamic'

type InventoryView = 'onhand' | 'movements' | 'counts' | 'locations' | 'bom'

function selectedView(sp: Record<string, string | string[] | undefined>): InventoryView {
  const candidate = pickString(sp.inventoryView) ?? pickString(sp.view)
  return candidate === 'movements' || candidate === 'counts' || candidate === 'locations' || candidate === 'bom'
    ? candidate
    : 'onhand'
}

export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const [t, tSetup] = await Promise.all([
    getTranslations('inventory'),
    getTranslations('admin.setup'),
  ])
  const authz = await requirePermission('items.read')
  await requireFeatureEnabled(authz.user.orgId, 'inventory')

  const orgId = authz.user.orgId
  const requestedView = selectedView(sp)
  const canManage = can(authz, 'items.manage')
  const canPost = can(authz, 'items.post')
  const canReverse = can(authz, 'items.reverse')
  const canSetup = can(authz, 'admin.setup.manage')
  const view = !canSetup && (requestedView === 'locations' || requestedView === 'bom')
    ? 'onhand'
    : requestedView
  const showMovementDrawer = pickString(sp.movement) === 'new' && canManage

  const tabs = [
    { href: '/inventory?inventoryView=onhand', label: t('view.onhand'), active: view === 'onhand' },
    { href: '/inventory?inventoryView=movements', label: t('view.movements'), active: view === 'movements' },
    { href: '/inventory?inventoryView=counts', label: t('view.counts'), active: view === 'counts' },
    ...(canSetup
      ? [
          { href: '/inventory?inventoryView=locations', label: t('view.locations'), active: view === 'locations' },
          { href: '/inventory?inventoryView=bom', label: t('view.bom'), active: view === 'bom' },
        ]
      : []),
  ]

  const movementPickers = showMovementDrawer
    ? await Promise.all([
        db.execute<{ id: string; code: string | null; name: string | null }>(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active order by it.name`),
        db.execute<{ id: string; code: string | null }>(sql`
          select id, code from stock_locations where org_id = ${orgId} and is_active order by code`),
        db.execute<{ id: string; number: string | null; name: string | null }>(sql`
          select id, number, name from accounts
           where org_id = ${orgId} and is_active and not is_summary
           order by number nulls last`),
      ])
    : null

  const countData = view === 'counts'
    ? await Promise.all([
        listStockCounts(orgId),
        db.execute<{ id: string; name: string | null }>(sql`
          select id, name from locations where org_id = ${orgId} and is_active order by name`),
        db.execute<{ id: string; name: string | null }>(sql`
          select id, name from subsidiaries where org_id = ${orgId} order by created_at, id`),
        db.execute<{ id: string; code: string | null; name: string | null }>(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active order by it.name`),
        db.execute<{ id: string; code: string | null }>(sql`
          select id, code from stock_locations where org_id = ${orgId} and is_active order by code`),
        db.execute<{ id: string; item_id: string; lot_number: string }>(sql`
          select id, item_id, lot_number from lots where org_id = ${orgId} order by lot_number`),
      ])
    : null

  const bomData = view === 'bom'
    ? await Promise.all([
        db.execute<BomAssembly>(sql`
          select b.assembly_item_id as "assemblyItemId",
                 assembly.code as "assemblyCode",
                 assembly.name as "assemblyName",
                 count(*)::int as "componentCount",
                 md5(string_agg(
                   b.id::text || ':' || b.updated_at::text || ':' || b.component_item_id::text || ':' ||
                   b.quantity_per::text || ':' || b.sort_order::text,
                   ',' order by b.sort_order, b.component_item_id
                 )) as version,
                 json_agg(json_build_object(
                   'id', b.id,
                   'componentItemId', b.component_item_id,
                   'quantityPer', b.quantity_per::text,
                   'sortOrder', b.sort_order
                 ) order by b.sort_order, b.component_item_id) as components
            from bom_components b
            join items assembly on assembly.org_id = b.org_id and assembly.id = b.assembly_item_id
           where b.org_id = ${orgId}
           group by b.assembly_item_id, assembly.code, assembly.name
           order by assembly.name nulls last, assembly.code nulls last, b.assembly_item_id`),
        db.execute<{ id: string; code: string | null; name: string | null }>(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active
           order by it.name nulls last, it.code nulls last, it.id`),
      ])
    : null

  const movementHref = `/inventory?inventoryView=${view}&movement=new`
  const closeMovementHref = `/inventory?inventoryView=${view}`
  const headerAction = view === 'onhand' || view === 'movements' ? (
    <>{canManage ? <NewMovementButton href={movementHref} /> : null}{canReverse ? <ReverseLandedVoucherAction /> : null}</>
  ) : view === 'counts' ? (
    canPost ? (
      <NewCountButton label={t('counts.newButton')} />
    ) : null
  ) : view === 'locations' ? (
    canSetup ? (
      <Button asChild><Link href="/inventory?inventoryView=locations&row=new"><Plus size={15} /> {tSetup('new')}</Link></Button>
    ) : null
  ) : canSetup ? (
    <NewBomButton label={tSetup('new')} />
  ) : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={<>{headerAction}<ModuleHomeTabs tabs={tabs} /></>}
        />
      }
    >
      {view === 'onhand' || view === 'movements' ? (
        <EntityListView
          recordType={view === 'onhand' ? 'inventory_onhand' : 'inventory_movement'}
          orgId={orgId}
          userId={authz.user.id}
          canManage={canManage}
          sp={sp}
          drawer={movementPickers ? (
            <InventoryActionDrawer
              items={movementPickers[0].rows}
              stockLocations={movementPickers[1].rows}
              accounts={movementPickers[2].rows}
              closeHref={closeMovementHref}
            />
          ) : undefined}
        />
      ) : null}

      {view === 'counts' && countData ? (
        <CountsList
          key={pickString(sp.countId) ?? (pickString(sp.count) === 'new' ? 'new' : 'list')}
          counts={countData[0].counts}
          totalCount={countData[0].totalCount}
          nextCursor={countData[0].nextCursor}
          locations={countData[1].rows}
          subsidiaries={countData[2].rows}
          items={countData[3].rows}
          stockLocations={countData[4].rows}
          lots={countData[5].rows}
          canPost={canPost}
          createRequested={pickString(sp.count) === 'new'}
          selectedCountId={pickString(sp.countId)}
        />
      ) : null}

      {view === 'locations' ? (
        <SetupEntitySection
          entity={SETUP_ENTITY_BY_KEY.get('stock-locations')!}
          orgId={orgId}
          searchParams={sp}
          basePath="/inventory"
          canManage={canSetup}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
          hideHeader
        />
      ) : null}

      {view === 'bom' && bomData ? (
        <BomWorkspace
          key={pickString(sp.bom) ?? 'list'}
          assemblies={bomData[0].rows}
          items={bomData[1].rows}
          selected={pickString(sp.bom)}
          canManage={canSetup}
        />
      ) : null}
    </ListPageLayout>
  )
}
