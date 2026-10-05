import 'server-only'

import { sql } from 'drizzle-orm'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { INDUSTRIES } from '../../../../../lib/industries'
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
 * `/api/admin/setup/features`, confirm via `confirmDialog`, and toast +
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
 * The `wizardHref` literal travels as data. The Industries tab's
 * per-vertical sections come from the industry registry (the wizard's
 * presets — the single source of what each vertical runs): each industry
 * contributes the feature keys its preset switches ON, and the org's own
 * applied industry travels so the tab can lead with it. No `t()` calls here — all
 * copy resolves inside the shared island via its existing hooks, so no
 * message key can be invented.
 */

type FeaturesWorkspaceProps = Parameters<typeof FeaturesWorkspace>[0]

export interface FeaturesData {
  features: FeaturesWorkspaceProps['features']
  disableStatus: FeaturesWorkspaceProps['disableStatus']
  wizardHref: string
  industries: NonNullable<FeaturesWorkspaceProps['industries']>
  orgIndustry: string | null
}

export async function loadFeatures(): Promise<FeaturesData> {
  const authz = await requirePermission('admin.setup.manage')
  const [state, org] = await Promise.all([
    resolvedFeatureState(authz.user.orgId),
    db.execute<{ industry: string | null }>(sql`select settings->>'industry' as industry from orgs where id = ${authz.user.orgId}`),
  ])

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

  const industries = INDUSTRIES.map((industry) => ({
    key: industry.key,
    features: Object.entries(industry.features)
      .filter(([, on]) => on)
      .map(([key]) => key),
  })).filter((industry) => industry.features.length > 0)

  return {
    features,
    disableStatus,
    wizardHref: '/admin/setup/wizard',
    industries,
    orgIndustry: org.rows[0]?.industry ?? null,
  }
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
        industries: data.industries,
        orgIndustry: data.orgIndustry,
      }),
    ],
  })
}
