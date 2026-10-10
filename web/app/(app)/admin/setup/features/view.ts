import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import {
  FEATURES,
  resolvedFeatureState,
  featureEnabled,
  featureDisableStatuses,
} from '../../../../../lib/features'
import type { FeaturesWorkspace } from './FeaturesWorkspace'

/**
 * Load the authoritative company feature state and disable safeguards. The
 * client workspace owns immediate tab navigation, toggle confirmation and
 * refusal handling; the setup wizard remains an onboarding shortcut.
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
    group: f.group,
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

  return {
    features,
    disableStatus,
    wizardHref: '/admin/setup/wizard',
  }
}

export function featuresSpec(data: FeaturesData): PageSpec {
  return page({
    route: '/admin/setup/features',
    // The setup workspace and client island own the page chrome.
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
