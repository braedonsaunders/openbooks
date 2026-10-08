import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { AI_PROVIDER_SPECS } from '../../../../lib/assistant/client'
import { getOrgAiSettings, type OrgAiSettings } from '../../../../lib/assistant/ai-config'
import type { ProviderSpecLite } from './AiSettingsForm'

/** Provider credentials and model choices remain separate from workforce policy and action limits. */

export interface AdminAiData {
  title: string
  description: string
  backHref: string
  backLabel: string
  specs: ProviderSpecLite[]
  initial: Omit<OrgAiSettings, 'agents'>
  settingsLinks: { href: string; label: string }[]
}

export async function loadAdminAi(rawParams?: Record<string, string | string[] | undefined>): Promise<AdminAiData> {
  void rawParams
  const authz = await requirePermission('admin.ai.manage')
  const t = await getTranslations('admin')

  // Serializable slice of the provider specs (no SDK code in the client bundle).
  const specs: ProviderSpecLite[] = AI_PROVIDER_SPECS.map((p) => ({
    value: p.value,
    label: p.label,
    baseUrl: p.baseUrl,
    requiresBaseUrl: p.requiresBaseUrl,
    fast: p.fast,
    smart: p.smart,
    keyHint: p.keyHint,
    modelHint: p.modelHint,
  }))

  // Pack policies live under Setup → Agents: allowlist the provider fields
  // across the client boundary instead of forwarding the whole settings read.
  const settings = await getOrgAiSettings(authz.user.orgId)
  const initial: Omit<OrgAiSettings, 'agents'> = {
    enabled: settings.enabled,
    provider: settings.provider,
    modelFast: settings.modelFast,
    modelSmart: settings.modelSmart,
    baseUrl: settings.baseUrl,
    hasKey: settings.hasKey,
    documentCapture: settings.documentCapture,
  }

  return {
    title: t('ai.title'),
    description: t('ai.description'),
    backHref: '/admin',
    backLabel: t('hub.title'),
    specs,
    initial,
    settingsLinks: can(authz, 'admin.setup.manage') && await isFeatureEnabled(authz.user.orgId, 'aiGovernanceLedger') ? [
      { href: '/admin/setup/ai-rails-settings', label: t('ai.workforceSettings') },
      { href: '/admin/setup/ai-capabilities', label: t('ai.actionLimits') },
    ] : [],
  }
}

const f = ref<AdminAiData>()

export function adminAiSpec(data: AdminAiData): PageSpec {
  return page({
    route: '/admin/ai',
    // The native page owns its own shell (PageContainer) the way the platform
    // hub does — ListPageLayout's sticky-header chrome would nest a second
    // shell around it, so header and body concatenate and the frame renders
    // the exact native shell. The header sits INSIDE the max-w-5xl wrapper,
    // not in the layout's sticky region.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        grid('max-w-5xl space-y-4', [
          pageHeader({
            back: { href: f('backHref'), label: f('backLabel') },
            title: f('title'),
            description: f('description'),
            actions: data.settingsLinks.map((item) => widget('link-button', { ...item, variant: 'outline', size: 'sm' })),
          }),
          // The card itself is spec-owned chrome (`rounded-lg border …
          // bg-white shadow-sm` + `CardContent p-6 pt-0` → merged `p-6
          // pt-6`); the island renders only its own space-y-5 form fields,
          // so the spec places the chrome around the widget, not inside it.
          // No `when` flags — the form always renders.
          frame('card', [
            grid('p-6 pt-6', [
              widgetBlock('ai-settings-form', {
                specs: f('specs'),
                initial: f('initial'),
              }),
            ]),
          ]),
        ]),
      ]),
    ],
  })
}
