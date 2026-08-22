import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { loadItem } from '../../api/items/_lib'
import { NewItemButton } from './NewItemButton'
import { NewItemRedirect } from './NewItemRedirect'
import { ItemDrawer } from './ItemDrawer'

export const dynamic = 'force-dynamic'

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('items')

  const authz = await requirePermission('items.read')
  const canManage = can(authz, 'items.manage')
  // Rate Books are shared billing configuration re-homed onto the catalog module
  // as a tab; managing them keeps the admin.setup.manage gate.
  const canSetup = can(authz, 'admin.setup.manage')
  const orgId = authz.user.orgId
  const [projectsEnabled, inventoryEnabled, revenueRecognitionEnabled, timeTrackingEnabled, equipmentEnabled] = await Promise.all([
    isFeatureEnabled(orgId, 'projects'),
    isFeatureEnabled(orgId, 'inventory'),
    isFeatureEnabled(orgId, 'revenueRecognition'),
    isFeatureEnabled(orgId, 'timeTracking'),
    isFeatureEnabled(orgId, 'equipment'),
  ])

  const sp = await searchParams
  const itemId = typeof sp.item === 'string' ? sp.item : undefined
  const view = canSetup && projectsEnabled && pickString(sp.view) === 'rate-books' ? 'rate-books' : 'catalog'
  const rateBooksEntity = view === 'rate-books' ? SETUP_ENTITY_BY_KEY.get('item-rate-books') ?? null : null

  // Catalog ↔ Rate Books switcher — visible tabs shown on both views when the
  // user can manage configuration, defined once and reused.
  const viewChips = canSetup && projectsEnabled ? (
    <ModuleHomeTabs
      tabs={[
        { href: '/items', label: t('list.viewCatalog'), active: view === 'catalog' },
        { href: '/items?view=rate-books', label: t('list.viewRateBooks'), active: view === 'rate-books' },
      ]}
    />
  ) : null

  if (rateBooksEntity) {
    return (
      <ListPageLayout
        header={
          <PageHeader title={t('list.title')} description={t('list.description')} actions={viewChips} />
        }
      >
        <SetupEntitySection
          entity={rateBooksEntity}
          orgId={orgId}
          searchParams={sp}
          basePath="/items"
          canManage={canSetup}
        />
      </ListPageLayout>
    )
  }
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
          revenueRecognitionEnabled
            ? db.execute(
                sql`select id, code, name from recognition_rules where org_id = ${orgId} and is_active and not is_forecast order by code`,
              ) as any
            : Promise.resolve({ rows: [] }),
        ])
      : null,
  ])

  const requestedReturn = pickString(sp.drawerReturn)
  const drawer = (
    <>
      {itemId === 'new' && canManage ? <NewItemRedirect /> : null}
      {openItem && pickers ? (
        <ItemDrawer
          key={String(openItem.item.id)}
          payload={openItem as any}
          accounts={pickers[0].rows}
          taxCodes={pickers[1].rows}
          fieldDefs={pickers[2] as any}
          recognitionRules={pickers[3].rows}
          canManage={canManage}
          basePath={requestedReturn?.startsWith('/items') ? requestedReturn : '/items'}
          laborPricing={projectsEnabled}
          inventoryCosting={inventoryEnabled}
          fairValuePrices={revenueRecognitionEnabled}
          timeTracking={timeTrackingEnabled}
          equipmentEnabled={equipmentEnabled}
        />
      ) : null}
    </>
  )

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={
              <div className="flex items-center gap-3">
                {viewChips}
                {canManage ? <NewItemButton /> : null}
              </div>
            }
          />
        </>
      }
    >
      <EntityListView
        recordType="item"
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={canManage ? <NewItemButton /> : undefined}
      />
    </ListPageLayout>
  )
}
