import 'server-only'

import type { ComponentProps } from 'react'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { can, getAuthz, type Authz } from '../../../lib/authz'
import { isFeatureEnabled, resolvedFeatureState } from '../../../lib/features'
import { setupChildEntities, resolveSetupEntityGate } from '../../../lib/setup/registry'
import { pickString } from '../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import { partyOptions } from '../../../lib/documents'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { ItemDrawer } from './ItemDrawer'
import { ItemVariantsTab } from './ItemVariantsTab'
import { KitComponentsTab } from './KitComponentsTab'
import { externalLinkUnlinkColumn } from '../channels/external-links-column'
import { listLinksByNative } from '@openbooks/engine/src/commerce/external-links.ts'
import { withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { PlanningTab } from '../inventory/planning/PlanningTab'

/**
 * A stocked item's Planning tab: days of cover, the next suggestion and the
 * planning policy beside them. Rides both drawer paths like the kit tab —
 * planners read cover without the setup grant, and only inventory.plan
 * holders may save the policy.
 */
async function itemPlanningTab(
  authz: Authz,
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode) return null
  if (!(await isFeatureEnabled(authz.user.orgId, 'demandPlanning'))) return null
  const itemId = String(props.payload.item.id)
  const stocked = (await db.execute<{ id: string }>(sql`
    select item_id as id from item_inventory_profiles
     where org_id = ${authz.user.orgId} and item_id = ${itemId} limit 1`)).rows[0]
  if (!stocked) return null
  if (pickString(sp.itemSetup) !== 'planning') {
    const t = await getTranslations('planning')
    return { key: 'planning', label: t('itemTab.title'), content: null }
  }
  const t = await getTranslations('planning')
  const subsidiaries = (await db.execute<{ id: string }>(sql`
    select s.id from subsidiaries s
     where s.org_id = ${authz.user.orgId} and s.is_active and not s.is_elimination
       ${subsidiaryVisibleFilter(sql`s.id`, authz.allowedSubsidiaryIds)}
     order by s.name limit 1`)).rows
  if (subsidiaries.length === 0) return null
  const vendors = await partyOptions('vendor', authz.user.orgId, authz.allowedSubsidiaryIds)
  return {
    key: 'planning',
    label: t('itemTab.title'),
    content: (
      <PlanningTab
        itemId={itemId}
        subsidiaryId={subsidiaries[0]!.id}
        canManage={can(authz, 'inventory.plan')}
        vendors={vendors.map((vendor) => ({ id: vendor.id, name: vendor.label ?? vendor.id }))}
      />
    ),
  }
}

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
  // setup grant pick and sell kits, so it rides both drawer paths. Planning
  // is operational the same way: a stocked item's cover and policy belong
  // to the planner, not to setup administration.
  const kitTab = await kitComponentsTab(authz.user.orgId, can(authz, 'items.manage'), props, sp)
  const planningTab = await itemPlanningTab(authz, props, sp)
  const variantsTab = await itemVariantsTab(props, sp)
  const operationalTabs = [...(kitTab ? [kitTab] : []), ...(planningTab ? [planningTab] : []), ...(variantsTab ? [variantsTab] : [])]
  if (props.createMode || !can(authz, 'admin.setup.manage') || authz.allowedSubsidiaryIds !== null) {
    return <ItemDrawer key={remountKey} {...props} recordTabs={operationalTabs} />
  }
  const features = await resolvedFeatureState(authz.user.orgId)
  const t = await getTranslations('admin.setup')
  // External identities resolve through the owning engine service: the
  // generic parent predicate cannot filter on the native table, so the tab
  // reads exactly this item's links and unlinks through the audited channel
  // endpoint instead of the generic setup delete.
  const showExternalLinks = resolveSetupEntityGate(
    { featureKey: undefined, featureKeysAny: ['salesChannels', 'usageBilling'] },
    features,
  ).enabled
  const externalLinkIds = showExternalLinks
    ? new Set(
        (await withOrgContext(authz.user.orgId, () =>
          listLinksByNative(authz.user.orgId, 'items', String(props.payload.item.id)),
        )).map((link) => link.id),
      )
    : new Set<string>()
  const canUnlinkExternal = showExternalLinks && can(authz, 'channels.manage')
  const recordTabs = [
    ...operationalTabs,
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
            canManage={entity.key === 'external-links' ? false : can(authz, 'items.manage')}
            allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
            parent={{ recordKey: 'items', value: String(props.payload.item.id) }}
            rowParam="recordRow"
            paramPrefix="record"
            stacked
            {...(entity.key === 'external-links'
              ? {
                  visibleRowIds: externalLinkIds,
                  renderColumn: externalLinkUnlinkColumn(canUnlinkExternal),
                }
              : {})}
          />
        ) : null,
      })),
  ]
  return <ItemDrawer key={remountKey} {...props} recordTabs={recordTabs} />
}

/**
 * A variant's siblings live beside the item, not under setup: operators
 * without the setup grant pick and sell variants, so the tab rides both
 * drawer paths like the kit and planning tabs. Readers without the variants
 * gate never see it; the gate lives on the drawer props.
 */
async function itemVariantsTab(
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode || !props.variantsEnabled || !props.family) return null
  const tFamilies = await getTranslations('items.families')
  return {
    key: 'variants',
    label: tFamilies('itemTab.title'),
    content: pickString(sp.itemSetup) === 'variants' ? (
      <ItemVariantsTab familyId={props.family.id} itemId={String(props.payload.item.id)} />
    ) : null,
  }
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
