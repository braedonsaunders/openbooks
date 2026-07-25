import { requirePermission } from '../../../../../lib/authz'
import { FEATURES, resolvedFeatureState, featureEnabled, featureDisableStatuses } from '../../../../../lib/features'
import { FeaturesWorkspace } from './FeaturesWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Features — the on/off switchboard for optional modules. Not every company
 * uses every feature; off = hidden from nav, routes 404, setup surfaces hide.
 * Data is never deleted by toggling.
 */
export default async function FeaturesSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const state = await resolvedFeatureState(authz.user.orgId)

  const features = FEATURES.map((f) => ({
    key: f.key,
    category: f.category,
    parentKey: f.parentKey,
    enabled: featureEnabled(state, f.key),
  }))
  // What turning each ENABLED feature off would affect (impacts + hard blocks).
  const disableStatus = await featureDisableStatuses(
    authz.user.orgId,
    features.filter((f) => f.enabled).map((f) => f.key),
  )

  return <FeaturesWorkspace features={features} disableStatus={disableStatus} wizardHref="/admin/setup/wizard" />
}
