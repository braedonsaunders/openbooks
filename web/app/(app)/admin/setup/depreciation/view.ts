import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, page, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import type { DepreciationSetupTabs } from './sections'

/**
 * The book-depreciation setup workspace, split into a loader and a spec.
 *
 * Two mutually exclusive registry-entity bodies behind one `?tab=` param —
 * the tax-depreciation precedent at its smallest: `methods` (the
 * user-authored formula builder) and `books` (the per-book, per-category
 * policy list). Presence flags (`onMethods` / `onBooks`) choose exactly one
 * of them; the spec never branches, it only places blocks and lets all but
 * one vanish. Both bodies arrive through the already-registered
 * `setup-section` slot, which re-derives org id, entry and manage gate from
 * the session.
 *
 * The loader copies the native page VERBATIM: the `admin.setup.manage`
 * gate, the `fixedAssets` feature gate, the tab fallback to `methods`, and
 * the header/tab strings from `admin.setup.assetDepreciationSetup`.
 */

const ENTITY_BY_TAB = {
  methods: 'depreciation-methods',
  books: 'depreciation-book-policies',
} as const
type Tab = keyof typeof ENTITY_BY_TAB

export interface DepreciationSetupData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: DepreciationSetupTabs
  tabsAria: string
  onMethods: boolean
  onBooks: boolean
  /** The registry key for the active tab; the flags are mutually exclusive,
   *  so exactly one `setup-section` block ever reads it (payroll precedent). */
  entityKey: string
}

export async function loadDepreciationSetup(
  sp: Record<string, string | string[] | undefined>,
): Promise<DepreciationSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const requested = pickString(sp.tab)
  const tab: Tab = requested && Object.hasOwn(ENTITY_BY_TAB, requested) ? requested as Tab : 'methods'
  const t = await getTranslations('admin.setup.assetDepreciationSetup')
  // The native page reads the tab straight from the registry; a key the
  // registry dropped would 404 in SetupDrawer — same belt-and-braces
  // `available` filter the tax-depreciation page uses. Both keys exist
  // today, so the behavior is identical; the guard only fires if the
  // registry ever drops one.
  const available: readonly Tab[] = (['methods', 'books'] as Tab[]).filter((key) =>
    SETUP_ENTITY_BY_KEY.has(ENTITY_BY_TAB[key]),
  )
  const active: Tab = available.includes(tab) ? tab : 'methods'
  const tabHref = (key: Tab): string => `/admin/setup/depreciation?tab=${key}`
  const tabs: DepreciationSetupData['tabs'] = [
    { key: 'methods', href: tabHref('methods'), label: t('tabs.methods'), active: active === 'methods' },
    { key: 'books', href: tabHref('books'), label: t('tabs.books'), active: active === 'books' },
  ]

  return {
    title: t('title'),
    description: t('description'),
    currentParams: sp,
    tabs,
    tabsAria: t('tabsAria'),
    onMethods: active === 'methods',
    onBooks: active === 'books',
    entityKey: ENTITY_BY_TAB[active],
  }
}

const f = ref<DepreciationSetupData>()

/**
 * The full tab workspace. The header (h1 + description + underline tab
 * strip) is shared chrome the spec cannot express (the active-vs-plain link
 * PAIR, aria-current set-vs-omitted); the two entity tabs are the registered
 * `setup-section` slot. Exactly one body block survives per render.
 */
export function depreciationSetupSpec(data: DepreciationSetupData): PageSpec {
  const basePath = '/admin/setup/depreciation'
  return page({
    route: '/admin/setup/depreciation',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome. The native
    // page owns its outer `<div className="space-y-5">`, so the spec places
    // the same element — the payroll/[entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-5', [
        widgetBlock('depreciation-setup-header', {
          title: data.title,
          description: data.description,
          tabs: data.tabs,
          tabsAria: data.tabsAria,
        }),
        // Both registry-entity tabs share the `setup-section` SLOT
        // (already registered): the slot re-derives org id, entry and manage
        // gate from the session. `onMethods` / `onBooks` are mutually
        // exclusive, so exactly one block ever reads `entityKey`.
        {
          ...widgetBlock('setup-section', {
            entityKey: data.entityKey,
            sp: data.currentParams,
            basePath,
          }),
          when: f('onMethods'),
        },
        {
          ...widgetBlock('setup-section', {
            entityKey: data.entityKey,
            sp: data.currentParams,
            basePath,
          }),
          when: f('onBooks'),
        },
      ]),
    ],
  })
}
