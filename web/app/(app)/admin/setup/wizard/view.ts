import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getAuthz, can } from '../../../../../lib/authz'
import { redirect } from 'next/navigation'
import { INDUSTRIES, canSwitchIndustry } from '../../../../../lib/industries'
import { FEATURES, featureEnabled, resolvedFeatureState } from '../../../../../lib/features'
import {
  isBookStart,
  isCloseCadence,
  isComplexityLevel,
  isMonthlyActivityLevel,
  isTaxPosition,
  isTeamSize,
} from '../../../../../lib/workspace-profile'
import type { SetupWizard } from './SetupWizard'

/**
 * The setup wizard page — used when the user re-runs the wizard from the
 * Features page ("Run setup wizard" button). On first login the wizard is
 * rendered inline by the app layout (see web/app/(app)/layout.tsx).
 *
 * Split into a loader and a spec.
 *
 * The whole surface renders inside ONE client island (`SetupWizard`): ten
 * animated steps (welcome → company → industry → profile → rhythm →
 * operations → [payroll] → launch → review → applying → done) that own
 * `useState` (every form field, every toggle, the step index, busy /
 * transitioning guards), fire `fetch` PUT/POST mutations against
 * `/api/admin/setup/wizard`, and animate via framer-motion. Decomposing
 * any of that into spec blocks would render inputs with no state flow and
 * strand the per-step validation / presets / review derivations from what
 * they act on (the features / bank-feeds / labor-costing lesson) — so the
 * island arrives whole through one widget.
 *
 * Loader work copied VERBATIM from page.tsx: the `getAuthz` + login /
 * `admin.setup.manage` redirects, the org row query, the
 * `canSwitchIndustry` probe, the `resolvedFeatureState` load, and the
 * `initial` assembly (fiscal-year default, `?? null` industry, guarded
 * workspace-profile fields, the 12-key feature toggles, the full-registry
 * `allFeatures` map). The `industries` registry travels as data; the
 * `isRerun` literal travels as data. No `t()` calls here — all copy
 * resolves inside the shared island via its existing hooks, so no
 * message key can be invented.
 */

type SetupWizardProps = Parameters<typeof SetupWizard>[0]

export interface WizardData {
  open: boolean
  industries: SetupWizardProps['industries']
  initial: SetupWizardProps['initial']
  canSwitchIndustry: boolean
  isRerun: boolean
}

export async function loadWizard(): Promise<WizardData> {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!can(authz, 'admin.setup.manage')) redirect('/')

  const orgId = authz.user.orgId
  const [org, switchable, features] = await Promise.all([
    db.execute(sql`
      select name, legal_name, base_currency, country, settings
        from orgs where id = ${orgId}`),
    canSwitchIndustry(orgId),
    resolvedFeatureState(orgId),
  ])
  const row = (org as unknown as { rows: { name: string; legal_name: string | null; base_currency: string; country: string; settings: Record<string, unknown> }[] }).rows[0]
  const settings = row?.settings ?? {}
  const storedProfile = settings.workspaceProfile as Record<string, unknown> | undefined

  return {
    open: true,
    industries: INDUSTRIES,
    initial: {
      name: row?.name ?? '',
      legalName: row?.legal_name ?? '',
      country: row?.country ?? '',
      baseCurrency: row?.base_currency ?? '',
      fiscalYearStartMonth: typeof settings.fiscalYearStartMonth === 'number' ? settings.fiscalYearStartMonth : 1,
      industry: (settings.industry as string) ?? null,
      workspaceProfile: {
        teamSize: isTeamSize(storedProfile?.teamSize) ? storedProfile.teamSize : 'solo',
        complexity: isComplexityLevel(storedProfile?.complexity) ? storedProfile.complexity : 'essentials',
        bookStart: isBookStart(storedProfile?.bookStart) ? storedProfile.bookStart : 'fresh',
        taxPosition: isTaxPosition(storedProfile?.taxPosition) ? storedProfile.taxPosition : 'unsure',
        monthlyActivity: isMonthlyActivityLevel(storedProfile?.monthlyActivity) ? storedProfile.monthlyActivity : 'light',
        closeCadence: isCloseCadence(storedProfile?.closeCadence) ? storedProfile.closeCadence : 'monthly',
      },
      features: {
        inventory: featureEnabled(features, 'inventory'),
        timeTracking: featureEnabled(features, 'timeTracking'),
        multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
        multiCurrency: featureEnabled(features, 'multiCurrency'),
        projects: featureEnabled(features, 'projects'),
        subscriptionBilling: featureEnabled(features, 'subscriptionBilling'),
        orders: featureEnabled(features, 'orders'),
        crm: featureEnabled(features, 'crm'),
        bankFeeds: featureEnabled(features, 'bankFeeds'),
        onlinePayments: featureEnabled(features, 'onlinePayments'),
        fixedAssets: featureEnabled(features, 'fixedAssets'),
        payroll: featureEnabled(features, 'payroll'),
      },
      allFeatures: Object.fromEntries(
        FEATURES.map((feature) => [feature.key, featureEnabled(features, feature.key)]),
      ),
    },
    canSwitchIndustry: switchable,
    isRerun: true,
  }
}

export function wizardSpec(data: WizardData): PageSpec {
  return page({
    route: '/admin/setup/wizard',
    // The setup workspace renders its own shell around every setup page, so
    // a second page layout would nest the chrome. And the fixed full-screen
    // scrim + centered card wrapper belongs to WizardShell itself — the
    // spec must NOT place it too, or the page renders that chrome twice
    // (the bank-feeds `max-w-4xl` / features `space-y-8` precedent).
    // The `open` / `isRerun` literals travel as data (the features
    // `wizardHref` precedent) so the spec only binds already-resolved fields.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('setup-wizard', {
        open: data.open,
        industries: data.industries,
        initial: data.initial,
        canSwitchIndustry: data.canSwitchIndustry,
        isRerun: data.isRerun,
      }),
    ],
  })
}
