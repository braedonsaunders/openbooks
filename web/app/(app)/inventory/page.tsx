import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { pickString } from '../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { NewMovementButton } from './NewMovementButton'
import { InventoryActionDrawer } from './InventoryActionDrawer'

export const dynamic = 'force-dynamic'

export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('inventory')

  const authz = await requirePermission('items.read')
  await requireFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'items.manage')
  // Stock Locations & Bill of Materials are configuration re-homed here from the
  // Setup workspace — managing them keeps the same admin.setup.manage gate.
  const canSetup = can(authz, 'admin.setup.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const sectionValues = ['onhand', 'movements', 'locations', 'bom'] as const
  const explicitSection = pickString(sp.inventoryView)
  const legacySection = pickString(sp.view)
  const rawView = explicitSection ?? (sectionValues.includes(legacySection as any) ? legacySection : undefined)
  const view = rawView && ['onhand', 'movements', 'locations', 'bom'].includes(rawView) ? rawView : 'onhand'
  // Configuration tabs render the shared registry section instead of ledger data.
  const setupEntityKey = view === 'locations' ? 'stock-locations' : view === 'bom' ? 'bom-components' : null
  const setupEntity = canSetup && setupEntityKey ? SETUP_ENTITY_BY_KEY.get(setupEntityKey) ?? null : null
  const showDrawer = pickString(sp.movement) === 'new'

  const viewTabs = [
    { href: '/inventory?inventoryView=onhand', label: t('view.onhand'), active: view === 'onhand' },
    { href: '/inventory?inventoryView=movements', label: t('view.movements'), active: view === 'movements' },
    ...(canSetup
      ? [
          { href: '/inventory?inventoryView=locations', label: t('view.locations'), active: view === 'locations' },
          { href: '/inventory?inventoryView=bom', label: t('view.bom'), active: view === 'bom' },
        ]
      : []),
  ]

  // -- drawer pickers -------------------------------------------------------
  const pickers = showDrawer && canManage
    ? await Promise.all([
        db.execute(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active order by it.name`) as any,
        db.execute(sql`select id, code from stock_locations where org_id = ${orgId} and is_active order by code`) as any,
        db.execute(
          sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last`,
        ) as any,
      ])
    : null

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={
              <div className="flex items-center gap-3">
                <ModuleHomeTabs tabs={viewTabs} />
                {!setupEntity && canManage ? <NewMovementButton /> : null}
              </div>
            }
          />
        </>
      }
    >
      {setupEntity ? (
        <SetupEntitySection
          entity={setupEntity}
          orgId={orgId}
          searchParams={sp}
          basePath="/inventory"
          canManage={canSetup}
        />
      ) : (
        <EntityListView
          recordType={view === 'onhand' ? 'inventory_onhand' : 'inventory_movement'}
          orgId={orgId}
          userId={authz.user.id}
          canManage={can(authz, 'admin.customization.manage')}
          sp={sp}
          drawer={showDrawer && pickers ? (
            <InventoryActionDrawer
              items={pickers[0].rows}
              stockLocations={pickers[1].rows}
              accounts={pickers[2].rows}
            />
          ) : null}
        />
      )}
    </ListPageLayout>
  )
}
