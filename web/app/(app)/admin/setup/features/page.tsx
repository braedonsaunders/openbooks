import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../../lib/authz'
import { FEATURES, orgFeatureState, featureEnabled } from '../../../../../lib/features'
import { FeaturesWorkspace } from './FeaturesWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Features — the on/off switchboard for optional modules. Not every company
 * uses every feature; off = hidden from nav, routes 404, setup surfaces hide.
 * Data is never deleted by toggling.
 */
export default async function FeaturesSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const state = await orgFeatureState(authz.user.orgId)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('setup.features.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('setup.features.description')}</p>
      </div>
      <FeaturesWorkspace
        features={FEATURES.map((f) => ({ key: f.key, enabled: featureEnabled(state, f.key) }))}
      />
    </div>
  )
}
