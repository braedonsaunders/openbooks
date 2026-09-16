import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'

export type AllocationsTab = 'rules' | 'drivers' | 'runs'

export interface AllocationsSetupData {
  tab: AllocationsTab
  /** Exactly one renders per request — the spec's tab conditions. */
  onRules: boolean
  onDrivers: boolean
  onRuns: boolean
  title: string
  description: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  tabsAria: string
  currentParams: Record<string, string | string[] | undefined>
}

/** Setup workspace gate (admin) + allocations feature; unknown tabs fall back to Rules. */
export async function loadAllocations(
  sp: Record<string, string | string[] | undefined>,
): Promise<AllocationsSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'allocations')
  const t = await getTranslations('allocations')
  const raw = typeof sp.tab === 'string' ? sp.tab : 'rules'
  const tab: AllocationsTab = raw === 'drivers' || raw === 'runs' ? raw : 'rules'
  const labels = {
    rules: t('rules.tabs.rules'),
    drivers: t('rules.tabs.drivers'),
    runs: t('rules.tabs.runs'),
  } as const
  return {
    tab,
    onRules: tab === 'rules',
    onDrivers: tab === 'drivers',
    onRuns: tab === 'runs',
    title: t('rules.title'),
    description: t('rules.description'),
    tabsAria: t('rules.tabsAria'),
    tabs: (Object.keys(labels) as AllocationsTab[]).map((key) => ({
      key,
      href: `/admin/setup/allocations?tab=${key}`,
      label: labels[key],
      active: key === tab,
    })),
    currentParams: sp,
  }
}

const f = ref<AllocationsSetupData>()

export function allocationsSpec(data: AllocationsSetupData): PageSpec {
  return page({
    route: '/admin/setup/allocations',
    // Bare like every setup custom page: the workspace owns the shell, the
    // native page owns its outer spacing — the [entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        // Shared chrome: h1, description, and the tab strip A7 owns. The
        // Drivers/Runs tab bodies are A8's; the strip stays here so tab order
        // never depends on which slice renders first.
        widgetBlock('allocations-setup-header', {
          title: data.title,
          description: data.description,
          tabs: data.tabs,
          tabsAria: data.tabsAria,
        }),
        // Rules tab: the versioned rule list with its `?rule=` drawer.
        // Org id and drawer state stay server-side in the slot.
        {
          ...widgetBlock('allocations-rules-tab', { sp: data.currentParams }),
          when: f('onRules'),
        },
        // Drivers tab: A8's island, mounted unchanged.
        {
          ...widgetBlock('allocations-drivers-tab', {}),
          when: f('onDrivers'),
        },
        // Runs tab: A8's island, mounted unchanged.
        {
          ...widgetBlock('allocations-runs-tab', {}),
          when: f('onRuns'),
        },
      ]),
    ],
  })
}
