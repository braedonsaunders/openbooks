import 'server-only'

import { page, grid, heading, textBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getTranslations } from 'next-intl/server'
import { requirePermission, guardRootSubsidiaryScope } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { notFound } from 'next/navigation'
import { pickString } from '../../../../../lib/list-params'

/**
 * Company Settings → Shipping, split into a loader and a spec.
 *
 * Four tabs share one page: carrier accounts (a client island that owns
 * the connect/test/disconnect forms against /api/shipping/accounts),
 * carrier billing adjustments (paste, preview, then import against one
 * account through POST /api/shipping/adjustments), package presets, and
 * the org's shipping settings row — the last two rendered by the shared
 * SetupEntitySection over rehomed registry entities, never bespoke tables.
 *
 * Both gates run here, so a spec render redirects exactly as the native
 * one does.
 */

const ENTITY_TABS = [
  { key: 'accounts', entityKey: null, labelKey: 'setup.shipping.tabs.accounts' },
  { key: 'adjustments', entityKey: null, labelKey: 'setup.shipping.tabs.adjustments' },
  { key: 'presets', entityKey: 'package-presets', labelKey: 'setup.entities.package-presets.title' },
  { key: 'settings', entityKey: 'shipping-settings', labelKey: 'setup.entities.shipping-settings.title' },
] as const

type ShippingTab = (typeof ENTITY_TABS)[number]['key']

export interface ShippingSetupData {
  title: string
  description: string
  tab: ShippingTab
  entityKey: string | null
  currentParams: Record<string, string | string[] | undefined>
  tabs: { href: string; label: string; active: boolean }[]
}

export async function loadShippingSetup(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<ShippingSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  if (await guardRootSubsidiaryScope(authz)) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'shippingHub')
  const t = await getTranslations('admin')
  const requested = pickString(sp.tab)
  const tab: ShippingTab = ENTITY_TABS.some((candidate) => candidate.key === requested)
    ? requested as ShippingTab
    : 'accounts'
  return {
    title: t('setup.shipping.title'),
    description: t('setup.shipping.description'),
    tab,
    entityKey: ENTITY_TABS.find((candidate) => candidate.key === tab)?.entityKey ?? null,
    currentParams: sp,
    tabs: ENTITY_TABS.map(({ key, labelKey }) => ({
      href: `/admin/setup/shipping?tab=${key}`,
      label: t(labelKey),
      active: key === tab,
    })),
  }
}

export function shippingSetupSpec(data: ShippingSetupData): PageSpec {
  return page({
    route: '/admin/setup/shipping',
    // The setup workspace renders its own shell around every setup page, so a
    // page layout here would nest the chrome — and the accounts island owns
    // whatever container it wants inside that.
    layout: 'bare',
    header: [],
    body: [grid('space-y-1', [
      heading(2, data.title, 'text-base font-semibold text-slate-900 dark:text-slate-100'),
      textBlock(data.description, { size: 'sm', className: 'text-slate-500 dark:text-slate-400' }),
    ])],
  })
}
