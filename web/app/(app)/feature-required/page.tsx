import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Power } from 'lucide-react'
import { getMessages, getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'
import { can, getAuthz } from '../../../lib/authz'
import { FEATURE_BY_KEY, isFeatureEnabled } from '../../../lib/features'
import { parseFeatureRequiredParam } from '../../../lib/gate-targets'

export const dynamic = 'force-dynamic'

/**
 * The shared explanation for a disabled feature (F-t13-002/003, F-t03-012).
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
  const t = await getTranslations('shell.routeState')
  // Feature titles live at admin.features.<key>.title, but coverage is not
  // complete in every locale — navigate the merged messages and fall back to
  // the raw key rather than crash or leak a key path.
  const messages = await getMessages()
  const admin = (messages as { admin?: unknown }).admin as
    | { features?: Record<string, { title?: unknown }> }
    | undefined
  const catalogTitle = admin?.features?.[key]?.title
  const name = typeof catalogTitle === 'string' && catalogTitle.trim() ? catalogTitle : key
  const dashboard = (
    <Button asChild>
      <Link href="/dashboard">{t('backToDashboard')}</Link>
    </Button>
  )
  if (await isFeatureEnabled(authz.user.orgId, key)) {
    return (
      <RouteStateView
        state="feature-disabled"
        icon={<Power />}
        title={t('featureOnTitle', { name })}
        description={t('featureOnDescription')}
        action={dashboard}
      />
    )
  }
  const description = t('featureOffDescription', { name })
  if (!can(authz, 'admin.setup.manage')) {
    return (
      <RouteStateView
        state="feature-disabled"
        icon={<Power />}
        title={t('featureOffTitle', { name })}
        description={`${description} ${t('askAdministrator')}`}
        action={dashboard}
      />
    )
  }
  return (
    <RouteStateView
      state="feature-disabled"
      icon={<Power />}
      title={t('featureOffTitle', { name })}
      description={description}
      action={
        <Button asChild>
          <Link href="/admin/setup/features">{t('turnOnFeature')}</Link>
        </Button>
      }
    />
  )
}
