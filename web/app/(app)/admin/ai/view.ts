import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { AI_PROVIDER_SPECS } from '../../../../lib/assistant/client'
import { getOrgAiSettings, type OrgAiSettings } from '../../../../lib/assistant/ai-config'
import {
  CONTINUOUS_CLOSE_DETECTOR_SPECS,
  isContinuousCloseAgentKey,
} from '@openbooks/engine/src/continuous-close.ts'
import type { ProviderSpecLite, DetectorSpecLite } from './AiSettingsForm'

/**
 * Admin → AI settings, split into a loader and a spec.
 *
 * The whole body is one client island: AiSettingsForm owns per-field useState
 * (provider/model/base-url/key, the agents array, document-capture fields),
 * the auto-load-models effect (fetch → /api/admin/ai/models on mount when a
 * key is on file), and every fetch mutation (save, test connection, clear
 * key, run-agent-now, document-capture test) plus the ?agent= configuration
 * drawer with its own draft state. None of that decomposes into spec blocks —
 * the provider selector driving the base-URL field is client state, the
 * conditional pairs (link when published, em-dash otherwise; enabled-badge
 * variants) are component logic, and the drawer navigates via router.push.
 * So the spec places one `ai-settings-form` widget and the loader binds every
 * prop verbatim from the native page: the permission gate, the provider-spec
 * slice, the org settings read, and the ?agent= key whitelist.
 *
 * Loader work copied verbatim from page.tsx: the `admin.ai.manage` gate, the
 * `getTranslations('admin')` reads for the chrome strings, the serializable
 * slice of AI_PROVIDER_SPECS (no SDK code in the client bundle), the
 * getOrgAiSettings call, and the isContinuousCloseAgentKey whitelist for the
 * drawer — an unrecognized ?agent= value resolves to null (no drawer), never
 * to a default agent. `initial` crosses the boundary whole (it is already the
 * no-secret UI-facing shape); dates stay raw ISO strings because the island
 * formats lastRunAt/nextRunAt client-side with Intl.DateTimeFormat.
 */

export interface AdminAiData {
  title: string
  description: string
  backHref: string
  backLabel: string
  specs: ProviderSpecLite[]
  detectorSpecs: DetectorSpecLite[]
  initial: OrgAiSettings
  selectedAgentKey: 'accounting' | 'finance' | null
}

export async function loadAdminAi(
  sp: Record<string, string | string[] | undefined>,
): Promise<AdminAiData> {
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

  const initial = await getOrgAiSettings(authz.user.orgId)
  const requestedAgent = sp.agent
  const selectedAgentKey = isContinuousCloseAgentKey(requestedAgent) ? requestedAgent : null

  return {
    title: t('ai.title'),
    description: t('ai.description'),
    backHref: '/admin',
    backLabel: t('hub.title'),
    specs,
    detectorSpecs: CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => ({
      ...spec,
      parameters: spec.parameters.map((parameter) => ({
        ...parameter,
      })),
    })),
    initial,
    selectedAgentKey,
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
                detectorSpecs: f('detectorSpecs'),
                initial: f('initial'),
                selectedAgentKey: f('selectedAgentKey'),
              }),
            ]),
          ]),
        ]),
      ]),
    ],
  })
}
