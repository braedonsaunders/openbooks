import { requirePermission } from '../../../../../lib/authz'
import { FEATURES, resolvedFeatureState, featureEnabled, featureDisableStatuses } from '../../../../../lib/features'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { FeaturesWorkspace } from './FeaturesWorkspace'
import { featuresSpec, loadFeatures } from './view'

export const dynamic = 'force-dynamic'

/**
 * Features — the on/off switchboard for optional modules. Not every company
 * uses every feature; off = hidden from nav, routes 404, setup surfaces hide.
 * Data is never deleted by toggling.
 */
export default async function FeaturesSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadFeatures()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={featuresSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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

  return <FeaturesWorkspace features={features} disableStatus={disableStatus} wizardHref="/admin/setup/wizard" />
}
