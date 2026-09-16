import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { AI_PROVIDER_SPECS } from '../../../../lib/assistant/client'
import { getOrgAiSettings, type OrgAiSettings } from '../../../../lib/assistant/ai-config'
import type { ProviderSpecLite } from './AiSettingsForm'

/**
 * Admin → AI providers, split into a loader and a spec.
 *
 * The whole body is one client island: AiSettingsForm owns per-field useState
 * (provider/model/base-url/key, document-capture fields), the
 * auto-load-models effect (fetch → /api/admin/ai/models on mount when a key
 * is on file), and every fetch mutation (save, test connection, clear key,
 * document-capture test). None of that decomposes into spec blocks — the
 * provider selector driving the base-URL field is client state and the
 * conditional pairs (link when published, em-dash otherwise; enabled-badge
 * variants) are component logic. So the spec places one `ai-settings-form`
 * widget and the loader binds every prop verbatim from the native page: the
 * permission gate, the provider-spec slice, and the org settings read.
 *
 * Background agent packs live under Setup → Agents (cross-linked from the
 * island); this surface keeps no agent policy, no detector specs and no
 * drawer selection. Loader work: the `admin.ai.manage` gate, the
 * `getTranslations('admin')` reads for the chrome strings, the serializable
 * slice of AI_PROVIDER_SPECS (no SDK code in the client bundle), and the
 * getOrgAiSettings call. `initial` crosses the boundary whole (it is already
 * the no-secret UI-facing shape).
 */

export interface AdminAiData {
  title: string
  description: string
  backHref: string
  backLabel: string
  specs: ProviderSpecLite[]
  initial: Omit<OrgAiSettings, 'agents'>
}

export async function loadAdminAi(): Promise<AdminAiData> {
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
  }
}

const f = ref<AdminAiData>()

export function adminAiSpec(data: AdminAiData): PageSpec {
  void data
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
