import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CircleCheck } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { FeatureUnavailable, featureDisplayName } from '@/components/feature-unavailable'
import { RouteStateView } from '@/components/route-state'
import { can, getAuthz } from '../../../lib/authz'
import { FEATURE_BY_KEY, isFeatureEnabled } from '../../../lib/features'
import { parseFeatureRequiredParam } from '../../../lib/gate-targets'

export const dynamic = 'force-dynamic'

/**
 * The shared explanation for a disabled feature.
 * Gates redirect here with ?feature=<key> instead of 404ing as if the route
 * were a typo: the page names the feature, says where to turn it on, and —
 * for visitors who cannot manage setup — who can. A crafted URL with no
 * known feature is honestly nonexistent, so it 404s like any other typo.
 */
export default async function FeatureRequiredPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const key = parseFeatureRequiredParam(sp.feature)
  if (!key || !FEATURE_BY_KEY.has(key)) {
    notFound()
  }
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (await isFeatureEnabled(authz.user.orgId, key)) {
    const t = await getTranslations('shell.routeState')
    const name = await featureDisplayName(key)
    return (
      <RouteStateView
        presentation="feature"
        label={name}
        state="feature-disabled"
        icon={<CircleCheck />}
        title={t('featureOnTitle', { name })}
        description={t('featureOnDescription')}
        action={
          <Button asChild size="lg" variant="outline">
            <Link href="/dashboard">{t('backToDashboard')}</Link>
          </Button>
        }
      />
    )
  }
  return FeatureUnavailable({
    featureKey: key,
    placement: 'route',
    canManageFeatures: can(authz, 'admin.setup.manage'),
  })
}
