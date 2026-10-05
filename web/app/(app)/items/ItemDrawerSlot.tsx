import 'server-only'

import type { ComponentProps } from 'react'
import { getTranslations } from 'next-intl/server'
import { can, getAuthz } from '../../../lib/authz'
import { isFeatureEnabled, resolvedFeatureState } from '../../../lib/features'
import { setupChildEntities, resolveSetupEntityGate } from '../../../lib/setup/registry'
import { pickString } from '../../../lib/list-params'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { ItemDrawer } from './ItemDrawer'
import { ItemVariantsTab } from './ItemVariantsTab'
import { KitComponentsTab } from './KitComponentsTab'

/** Item-owned configuration uses the same scoped list and drawer as setup records. */
export async function ItemDrawerSlot({ drawer, sp }: {
  drawer: (ComponentProps<typeof ItemDrawer> & { remountKey: string }) | null
  sp: Record<string, string | string[] | undefined>
}) {
  if (!drawer) return null
  const { remountKey, ...props } = drawer
  const authz = await getAuthz()
  if (!authz || !can(authz, 'items.read')) return null
  // A kit's Components tab is operational, not setup: operators without the
  // setup grant pick and sell kits, so it rides both drawer paths.
  const kitTab = await kitComponentsTab(authz.user.orgId, can(authz, 'items.manage'), props, sp)
  if (props.createMode || !can(authz, 'admin.setup.manage') || authz.allowedSubsidiaryIds !== null) {
    return <ItemDrawer key={remountKey} {...props} recordTabs={kitTab ? [kitTab] : []} />
  }
  const features = await resolvedFeatureState(authz.user.orgId)
  const [t, tFamilies] = await Promise.all([getTranslations('admin.setup'), getTranslations('items.families')])
  const variantsTab = !props.createMode && props.variantsEnabled && props.family
    ? [{
        key: 'variants',
        label: tFamilies('itemTab.title'),
        content: pickString(sp.itemSetup) === 'variants' ? (
          <ItemVariantsTab familyId={props.family.id} itemId={String(props.payload.item.id)} />
        ) : null,
      }]
    : []
  const recordTabs = [
    ...(kitTab ? [kitTab] : []),
    ...variantsTab,
    ...setupChildEntities('items')
      .filter((entity) => resolveSetupEntityGate(entity, features).enabled)
      .map((entity) => ({
        key: entity.key,
        label: t(`entities.${entity.key}.title`),
        content: pickString(sp.itemSetup) === entity.key ? (
          <SetupEntitySection
            entity={{ ...entity, columns: entity.columns.filter((column) => column.key !== 'itemId') }}
            orgId={authz.user.orgId}
            actorId={authz.user.id}
            searchParams={sp}
            basePath="/items"
            canManage={can(authz, 'items.manage')}
            allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
            parent={{ recordKey: 'items', value: String(props.payload.item.id) }}
            rowParam="recordRow"
            paramPrefix="record"
            stacked
          />
        ) : null,
      })),
  ]
  return <ItemDrawer key={remountKey} {...props} recordTabs={recordTabs} />
}

/**
 * A kit sells as a bundle of its components: the Components tab names the
 * recipe and what it can still sell, with the bill-of-materials editor one
 * click away. Kits without the inventory feature have no recipe to show.
 */
async function kitComponentsTab(
  orgId: string,
  canManage: boolean,
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode || String(props.payload.item.kind) !== 'kit') return null
  if (!(await isFeatureEnabled(orgId, 'inventory'))) return null
  const t = await getTranslations('items')
  const itemId = String(props.payload.item.id)
  const code = String(props.payload.item.code ?? '').trim()
  const name = String(props.payload.item.name ?? '').trim()
  return {
    key: 'components',
    label: t('kit.tab'),
    content: pickString(sp.itemSetup) === 'components' ? (
      <KitComponentsTab
        itemId={itemId}
        itemLabel={code ? `${code} · ${name}` : name || itemId}
        canManage={canManage}
        tabHref={`/items?item=${encodeURIComponent(itemId)}&itemSetup=components`}
        editing={pickString(sp.kitBom) === 'edit'}
      />
    ) : null,
  }
}
