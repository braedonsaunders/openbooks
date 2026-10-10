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
import { AssemblyRecipeTab } from './AssemblyRecipeTab'
import { KitAvailabilityTab } from './KitAvailabilityTab'
import { KitComponentsTab } from './KitComponentsTab'
import { ChannelStockTab } from './ChannelStockTab'
import { externalLinkUnlinkColumn } from '../channels/external-links-column'
import { listItemChannelStock, listLinksByNative } from '@openbooks/engine/commerce'
import { withOrgContext } from '@openbooks/engine/platform/database'
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
  // Kit editing follows PUT's gate (org-wide configuration): the Edit
  // affordance appears only where the save would be accepted, so a
  // restricted operator reads the recipe without being offered a refused
  // write.
  const kitTab = await kitComponentsTab(authz.user.orgId, can(authz, 'admin.setup.manage') && authz.allowedSubsidiaryIds === null, props, sp)
  const kitAvailabilityTab = await kitAvailabilitySection(authz.user.orgId, props, sp)
  const assemblyRecipeTab = await assemblyRecipeSection(authz.user.orgId, can(authz, 'admin.setup.manage') && authz.allowedSubsidiaryIds === null, props, sp)
  const planningTab = await itemPlanningTab(authz, props, sp)
  const variantsTab = await itemVariantsTab(props, sp)
  const channelStockTab = await itemChannelStockTab(authz, props, sp)
  // A planner edits the item's planning policy through the item's Edit and
  // Save even without managing the item itself.
  const recordSectionEditors = planningTab !== null && can(authz, 'inventory.plan')
  const operationalTabs = [...(kitTab ? [kitTab] : []), ...(kitAvailabilityTab ? [kitAvailabilityTab] : []), ...(assemblyRecipeTab ? [assemblyRecipeTab] : []), ...(planningTab ? [planningTab] : []), ...(variantsTab ? [variantsTab] : []), ...(channelStockTab ? [channelStockTab] : [])]
  if (props.createMode || !can(authz, 'admin.setup.manage') || authz.allowedSubsidiaryIds !== null) {
    return <ItemDrawer key={remountKey} {...props} recordTabs={operationalTabs} recordSectionEditors={recordSectionEditors} />
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
  return <ItemDrawer key={remountKey} {...props} recordTabs={recordTabs} recordSectionEditors={recordSectionEditors} />
}

/**
 * An item's storefront stock lives beside the item, not under setup:
 * operators without the setup grant read what the storefront shows, so the
 * tab rides both drawer paths like the kit and planning tabs. Policy
 * changes stay on the channel side; this tab only reads.
 */
async function itemChannelStockTab(
  authz: Authz,
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode) return null
  if (!can(authz, 'channels.read')) return null
  if (!(await isFeatureEnabled(authz.user.orgId, 'salesChannels'))) return null
  const t = await getTranslations('channels')
  if (pickString(sp.itemSetup) !== 'channels') {
    return { key: 'channels', label: t('itemTab.title'), content: null }
  }
  const rows = await withOrgContext(authz.user.orgId, () =>
    listItemChannelStock(authz.user.orgId, String(props.payload.item.id)),
  )
  return { key: 'channels', label: t('itemTab.title'), content: <ChannelStockTab rows={rows} /> }
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
 * An assembly's Recipe tab: what manufacturing builds the finished item
 * from. Assemblies without an inventory costing profile cannot stage a
 * recipe the save would keep, so the tab stays visible and names that
 * prerequisite instead of vanishing — the same explanation the produced-item
 * picker gives when no profiled item exists. Readers see it without the
 * setup grant like the kit recipe; replacing the recipe stays an
 * org-wide configuration write.
 */
async function assemblyRecipeSection(
  orgId: string,
  canManage: boolean,
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode || String(props.payload.item.kind) !== 'assembly') return null
  if (!(await isFeatureEnabled(orgId, 'inventory'))) return null
  const t = await getTranslations('items')
  const itemId = String(props.payload.item.id)
  const code = String(props.payload.item.code ?? '').trim()
  const name = String(props.payload.item.name ?? '').trim()
  const profiled = (await db.execute(sql`
    select item_id from item_inventory_profiles
     where org_id = ${orgId} and item_id = ${itemId} limit 1`)).rows.length > 0
  const tabHref = `/items?item=${encodeURIComponent(itemId)}&itemSetup=recipe`
  return {
    key: 'recipe',
    label: t('assembly.tab'),
    content: pickString(sp.itemSetup) === 'recipe' ? (
      <AssemblyRecipeTab
        itemId={itemId}
        itemLabel={code ? `${code} · ${name}` : name || itemId}
        canManage={canManage}
        tabHref={tabHref}
        editing={pickString(sp.assemblyBom) === 'edit'}
        hasCostingProfile={profiled}
      />
    ) : null,
  }
}

/**
 * A kit's per-warehouse availability lives on its own tab beside Components:
 * stock by location is a second concept table, so it never stacks below the
 * recipe. Readers see it without the setup grant like the recipe itself.
 */
async function kitAvailabilitySection(
  orgId: string,
  props: ComponentProps<typeof ItemDrawer>,
  sp: Record<string, string | string[] | undefined>,
) {
  if (props.createMode || String(props.payload.item.kind) !== 'kit') return null
  if (!(await isFeatureEnabled(orgId, 'inventory'))) return null
  const t = await getTranslations('items')
  const itemId = String(props.payload.item.id)
  return {
    key: 'availability',
    label: t('kit.availabilityTitle'),
    content: pickString(sp.itemSetup) === 'availability' ? (
      <KitAvailabilityTab itemId={itemId} />
    ) : null,
  }
}

/**
 * A kit sells as a bundle of its components: the Components tab names the
 * recipe, with the bill-of-materials editor one click away. Stock by location
 * lives on the sibling Availability tab. Kits without the inventory feature
 * have no recipe to show.
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
