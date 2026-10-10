import 'server-only'

import Link from 'next/link'
import { ArrowRight, Power, Workflow } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button, EmptyState } from '@openbooks/ui'
import { RouteStateView } from './route-state'

/** Where to turn an organization feature on: Company Settings → Features. */
export const FEATURES_SETUP_HREF = '/admin/setup/features'

/**
 * The operator-facing name of a feature, from the Features catalog
 * (`admin.features.<key>.title`). A key the catalog does not title falls back
 * to the key itself rather than crashing or leaking a message path.
 */
export async function featureDisplayName(featureKey: string): Promise<string> {
  const t = await getTranslations('admin.features')
  const path = `${featureKey}.title`
  return t.has(path as never) ? t(path as never) : featureKey
}

/**
 * The one presentation for "this needs a feature that is turned off".
 *
 * - `route`: the whole page is the explanation (the feature-required route).
 * - `section`: a page keeps its header and navigation, and its body is
 *   replaced by the same canvas. The page header's create actions are
 *   withdrawn by the shared page-layout rule in globals.css.
 * - `inline`: one panel of a larger surface is unavailable; the compact
 *   empty-state variant carries the same copy and remedy.
 *
 * Operators who may manage setup get a link to Company Settings → Features;
 * everyone else is told to ask an administrator. The server keeps enforcing
 * the feature — this only explains a refusal that already happened.
 */
export async function FeatureUnavailable({
  featureKey,
  canManageFeatures,
  placement = 'section',
}: {
  featureKey: string
  /** `admin.setup.manage`, resolved by the caller from its own authority. */
  canManageFeatures: boolean
  placement?: 'route' | 'section' | 'inline'
}) {
  const t = await getTranslations('shell.routeState')
  const name = await featureDisplayName(featureKey)
  const title = t('featureOffTitle', { name })
  const explanation = t('featureOffDescription', { name })
  const description = canManageFeatures ? explanation : `${explanation} ${t('askAdministrator')}`
  const icon = featureKey === 'automations' ? <Workflow /> : <Power />

  if (placement === 'inline') {
    return (
      <div data-feature-state="disabled" data-feature-key={featureKey}>
        <EmptyState
          icon={icon}
          title={title}
          description={description}
          action={canManageFeatures ? (
            <Button asChild size="sm">
              <Link href={FEATURES_SETUP_HREF}>{t('turnOnFeature')}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
            </Button>
          ) : undefined}
        />
      </div>
    )
  }

  const dashboard = (
    <Button asChild size="lg" variant="outline">
      <Link href="/dashboard">{t('backToDashboard')}</Link>
    </Button>
  )
  return (
    <RouteStateView
      presentation="feature"
      placement={placement}
      label={name}
      state="feature-disabled"
      icon={icon}
      title={title}
      description={description}
      action={canManageFeatures ? (
        <Button asChild size="lg">
          <Link href={FEATURES_SETUP_HREF}>{t('turnOnFeature')}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
        </Button>
      ) : dashboard}
      secondaryAction={canManageFeatures ? dashboard : undefined}
    />
  )
}
