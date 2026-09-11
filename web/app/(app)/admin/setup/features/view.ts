import 'server-only'

import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import {
  FEATURES,
  resolvedFeatureState,
  featureEnabled,
  featureDisableStatuses,
} from '../../../../../lib/features'
import type { FeaturesWorkspace } from './FeaturesWorkspace'

/**
 * Features — the on/off switchboard for optional modules, split into a
 * loader and a spec.
 *
 * The native page is a permission gate + a feature-state load + the disable
 * probes, then the whole surface renders inside ONE client island
 * (`FeaturesWorkspace`): the toggle switches own `useState` (switch state,
 * pending key), fire `fetch` PUT mutations against
 * `/api/admin/setup/features`, confirm via `window.confirm`, and toast +
 * `router.refresh()` on completion. Decomposing its grouped rows into a
 * spec repeat would render switches with no toggle flow and strand the
 * confirm/toast logic from what it acts on (the labor-costing /
 * bank-feeds lesson) — so the island arrives whole through one widget.
 *
 * Loader work copied VERBATIM from page.tsx: the `admin.setup.manage`
 * gate, the resolved feature state (with the multiSubsidiary /
 * multiCurrency data-dependent defaults), the `FEATURES.map` with
 * `featureEnabled`, and the `featureDisableStatuses` probe over exactly
 * the ENABLED keys (What turning each ENABLED feature off would affect).
 * The `wizardHref` literal travels as data. No `t()` calls here — all
 * copy resolves inside the shared island via its existing hooks, so no
 * message key can be invented.
 */

type FeaturesWorkspaceProps = Parameters<typeof FeaturesWorkspace>[0]

export interface FeaturesData {
  features: FeaturesWorkspaceProps['features']
  disableStatus: FeaturesWorkspaceProps['disableStatus']
  wizardHref: string
}

export async function loadFeatures(): Promise<FeaturesData> {
  const authz = await requirePermission('admin.setup.manage')
  const state = await resolvedFeatureState(authz.user.orgId)

  const features = FEATURES.map((f) => ({
    key: f.key,
    category: f.category,
    parentKey: f.parentKey,
    requiresAll: f.requiresAll,
    recommends: f.recommends,
    enabled: featureEnabled(state, f.key),
  }))
  // What turning each ENABLED feature off would affect (impacts + hard blocks).
  const disableStatus = await featureDisableStatuses(
    authz.user.orgId,
    features.filter((f) => f.enabled).map((f) => f.key),
  )

  return { features, disableStatus, wizardHref: '/admin/setup/wizard' }
}

export function featuresSpec(data: FeaturesData): PageSpec {
  return page({
    route: '/admin/setup/features',
    // The setup workspace renders its own shell around every setup page, so
    // a second page layout would nest the chrome. And the `space-y-8`
    // wrapper belongs to FeaturesWorkspace itself — the spec must NOT
    // place it too, or the page renders that div twice (the bank-feeds
    // `max-w-4xl` precedent).
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('features-workspace', {
        features: data.features,
        disableStatus: data.disableStatus,
        wizardHref: data.wizardHref,
      }),
    ],
  })
}
