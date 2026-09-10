import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { pickString } from '../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'

/**
 * Inventory, split into a loader and a spec.
 *
 * Four searchParam-driven sections over two very different kinds of body:
 *
 *  - `onhand` / `movements` are the universal EntityListView, so each list
 *    arrives through the slot that re-derives Authz server-side. The spec
 *    carries only the record type, the current params, and a drawer widget
 *    ref — never an org id.
 *  - `locations` / `bom` are configuration tabs that render the shared
 *    registry-backed SetupEntitySection server component instead of ledger
 *    data. That component queries, formats, and renders a whole management
 *    table of its own — decomposing it into spec blocks would reimplement it
 *    rather than compose it, so (like the statement matrix and the tax pools)
 *    it is one widget. The registry lookup still happens in the loader: the
 *    section renders only when the caller may manage setup, otherwise the
 *    spec falls back to the movements list exactly as the native page does.
 *
 * The create-movement drawer is a client island that needs only three picker
 * lists, so its payload rides the entity list's drawer slot with no remount
 * key — the native page renders it without one.
 */

export interface InventoryData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  viewTabs: { href: string; label: string; active: boolean }[]
  showNewMovement: boolean
  onOnhand: boolean
  onMovements: boolean
  onSetup: boolean
  setupEntityKey: string
  drawer: {
    items: { id: string; code: string | null; name: string | null }[]
    stockLocations: { id: string; code: string | null }[]
    accounts: { id: string; number: string | null; name: string | null }[]
  } | null
}

export async function loadInventory(
  sp: Record<string, string | string[] | undefined>,
): Promise<InventoryData> {
  const t = await getTranslations('inventory')
  const authz = await requirePermission('items.read')
  await requireFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'items.manage')
  // Stock Locations & Bill of Materials are configuration re-homed here from the
  // Setup workspace — managing them keeps the same admin.setup.manage gate.
  const canSetup = can(authz, 'admin.setup.manage')
  const orgId = authz.user.orgId

  const sectionValues = ['onhand', 'movements', 'locations', 'bom'] as const
  const explicitSection = pickString(sp.inventoryView)
  const legacySection = pickString(sp.view)
  const rawView =
    explicitSection ??
    (sectionValues.includes(legacySection as unknown as 'locations' | 'onhand' | 'movements' | 'bom')
      ? legacySection
      : undefined)
  const view =
    rawView && ['onhand', 'movements', 'locations', 'bom'].includes(rawView) ? rawView : 'onhand'
  // Configuration tabs render the shared registry section instead of ledger data.
  const setupEntityKey = view === 'locations' ? 'stock-locations' : view === 'bom' ? 'bom-components' : null
  const setupEntity = canSetup && setupEntityKey ? SETUP_ENTITY_BY_KEY.get(setupEntityKey) ?? null : null
  const showDrawer = pickString(sp.movement) === 'new'

  // -- drawer pickers -------------------------------------------------------
  const pickers =
    showDrawer && canManage
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

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    viewTabs: [
      { href: '/inventory?inventoryView=onhand', label: t('view.onhand'), active: view === 'onhand' },
      {
        href: '/inventory?inventoryView=movements',
        label: t('view.movements'),
        active: view === 'movements',
      },
      ...(canSetup
        ? [
            {
              href: '/inventory?inventoryView=locations',
              label: t('view.locations'),
              active: view === 'locations',
            },
            {
              href: '/inventory?inventoryView=bom',
              label: t('view.bom'),
              active: view === 'bom',
            },
          ]
        : []),
    ],
    // The native page renders the button whenever the body is a ledger list
    // (`!setupEntity`) and the reader may manage items.
    showNewMovement: !setupEntity && canManage,
    // Without the setup permission a config tab falls through to the
    // movements list — `view === 'onhand'` is the only on-hand case.
    onOnhand: !setupEntity && view === 'onhand',
    onMovements: !setupEntity && view !== 'onhand',
    onSetup: setupEntity !== null,
    setupEntityKey: setupEntity?.key ?? '',
    drawer:
      showDrawer && pickers
        ? {
            items: pickers[0].rows,
            stockLocations: pickers[1].rows,
            accounts: pickers[2].rows,
          }
        : null,
  }
}

const f = ref<InventoryData>()

export function inventorySpec(data: InventoryData): PageSpec {
  const newMovement = {
    widget: 'new-movement',
    props: {},
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('module-home-tabs', { tabs: data.viewTabs }),
          widget(newMovement.widget, newMovement.props, f('showNewMovement')),
        ],
      }),
    ],
    body: [
      {
        // The native page passes no emptyAction: the shared list renders its
        // own empty state, and both paths mount the same component.
        ...widgetBlock('entity-list-view', {
          recordType: 'inventory_onhand',
          sp: data.currentParams,
          drawer: data.drawer
            ? {
                widget: 'inventory-action-drawer',
                props: {
                  items: data.drawer.items,
                  stockLocations: data.drawer.stockLocations,
                  accounts: data.drawer.accounts,
                },
              }
            : null,
        }),
        when: f('onOnhand'),
      },
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'inventory_movement',
          sp: data.currentParams,
          drawer: data.drawer
            ? {
                widget: 'inventory-action-drawer',
                props: {
                  items: data.drawer.items,
                  stockLocations: data.drawer.stockLocations,
                  accounts: data.drawer.accounts,
                },
              }
            : null,
        }),
        when: f('onMovements'),
      },
      {
        ...widgetBlock('setup-section', {
          entityKey: data.setupEntityKey,
          basePath: '/inventory',
          sp: data.currentParams,
        }),
        when: f('onSetup'),
      },
    ],
  })
}
