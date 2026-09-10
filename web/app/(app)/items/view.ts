import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'
import { loadItem } from '../../api/items/_lib'
import type { ItemDrawer } from './ItemDrawer'

/**
 * The item catalog, split into a loader and a spec.
 *
 * Two bodies, chosen by two presence flags the LOADER computes: the catalog
 * entity list (with a flyout drawer fragment — create-redirect plus record
 * flyout, the projects idiom), or the re-homed Rate Books setup surface when
 * the user can manage configuration, projects are on, and `?view=rate-books`.
 *
 * The Rate Books body is one opaque `setup-entity-section` widget, not spec
 * vocabulary. It is a registry-driven CRUD surface (search, enum filters,
 * pagination, drawer) that re-derives `orgId` and permissions server-side
 * from the session — a capability, not data — so the spec names only the
 * entity key and the base path. The `SETUP_ENTITY_BY_KEY` lookup stays in the
 * loader: the spec never selects configuration.
 *
 * The header actions keep the native per-view markup: the catalog view wraps
 * `{viewChips}{<NewItemButton/>}` in `flex items-center gap-3` INSIDE
 * `PageHeader`'s own actions container; the rate-books view passes the bare
 * tabs. The `wrap` prop selects between them — data, not branching.
 *
 * The item drawer keeps its remount key (`key={item.id}` on the native page)
 * so switching items resets its client form state.
 */

type ItemDrawerProps = Parameters<typeof ItemDrawer>[0]

export interface ItemsData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  onRateBooks: boolean
  onCatalog: boolean
  // Header actions, identical on both views: the Catalog ↔ Rate Books
  // switcher (null unless the user can manage configuration with projects
  // on) plus the New button on the catalog view.
  tabs: { href: string; label: string; active: boolean }[]
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadItems(
  sp: Record<string, string | string[] | undefined>,
): Promise<ItemsData> {
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

  const itemId = typeof sp.item === 'string' ? sp.item : undefined
  const view = canSetup && projectsEnabled && pickString(sp.view) === 'rate-books' ? 'rate-books' : 'catalog'
  const rateBooksEntity = view === 'rate-books' ? SETUP_ENTITY_BY_KEY.get('item-rate-books') ?? null : null

  // Catalog ↔ Rate Books switcher — visible tabs shown on both views when the
  // user can manage configuration, defined once and reused. Empty when the
  // gate fails: ModuleHomeTabs renders nothing for fewer than two tabs, which
  // matches the native `{viewChips}` (null when the gate fails) exactly.
  const showTabs = canSetup && projectsEnabled
  const tabs = showTabs
    ? [
        { href: '/items', label: t('list.viewCatalog'), active: view === 'catalog' },
        { href: '/items?view=rate-books', label: t('list.viewRateBooks'), active: view === 'rate-books' },
      ]
    : []

  if (rateBooksEntity) {
    return {
      title: t('list.title'),
      description: t('list.description'),
      canManage,
      currentParams: sp,
      onRateBooks: true,
      onCatalog: false,
      tabs,
      showNewRedirect: false,
      drawer: null,
    }
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
  const drawer =
    openItem && pickers
      ? {
          remountKey: String(openItem.item.id),
          payload: openItem as unknown as ItemDrawerProps['payload'],
          accounts: pickers[0].rows,
          taxCodes: pickers[1].rows,
          fieldDefs: pickers[2] as unknown as ItemDrawerProps['fieldDefs'],
          recognitionRules: pickers[3].rows,
          canManage,
          basePath: requestedReturn?.startsWith('/items') ? requestedReturn : '/items',
          laborPricing: projectsEnabled,
          inventoryCosting: inventoryEnabled,
          fairValuePrices: revenueRecognitionEnabled,
          timeTracking: timeTrackingEnabled,
          equipmentEnabled,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    onRateBooks: false,
    onCatalog: true,
    tabs,
    showNewRedirect: itemId === 'new' && canManage,
    drawer,
  }
}

const f = ref<ItemsData>()

export function itemsSpec(data: ItemsData): PageSpec {
  const newItem = { widget: 'new-item', props: {} }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // The native page wraps the tabs and (on the catalog view) the New
        // button in a flex div inside the header actions container.
        actions: [
          widget('items-header-actions', {
            tabs: data.tabs,
            showNew: data.onCatalog && data.canManage,
            // The native catalog view wraps tabs + button in a flex div;
            // the rate-books view passes the tabs bare.
            wrap: data.onCatalog,
          }),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'item',
          sp: data.currentParams,
          emptyAction: data.canManage ? newItem : null,
          // Rendered in the native page's order: the create-redirect first,
          // then the record flyout.
          drawer: [
            data.showNewRedirect ? { widget: 'new-item-redirect', props: {} } : null,
            data.drawer ? { widget: 'item-drawer', props: { drawer: data.drawer } } : null,
          ].filter(Boolean),
        }),
        when: f('onCatalog'),
      },
      {
        ...widgetBlock('setup-section', {
          entityKey: 'item-rate-books',
          basePath: '/items',
          sp: data.currentParams,
        }),
        when: f('onRateBooks'),
      },
    ],
  })
}
