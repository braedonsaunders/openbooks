import { getTranslations } from 'next-intl/server'
import { Card, CardContent, PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { AI_PROVIDER_SPECS } from '../../../../lib/assistant/client'
import { getOrgAiSettings } from '../../../../lib/assistant/ai-config'
import { CONTINUOUS_CLOSE_DETECTOR_SPECS, isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close.ts'
import { AiSettingsForm, type ProviderSpecLite } from './AiSettingsForm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.ai')
  return { title: t('metaTitle') }
}

/**
 * Admin → AI settings. The provider,
 * model choices, and encrypted API key live in orgs.settings.ai — never in the
 * environment. The client form only ever sees non-secret fields (hasKey, not
 * the key itself).
 */
export default async function AiSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const requestedAgent = (await searchParams).agent
  const selectedAgentKey = isContinuousCloseAgentKey(requestedAgent) ? requestedAgent : null

  return (
    <PageContainer>
      <div className="max-w-5xl space-y-4">
        <PageHeader
          title={t('ai.title')}
          description={t('ai.description')}
          back={{ href: '/admin', label: t('hub.title') }}
        />
        <Card>
          <CardContent className="pt-6">
            <AiSettingsForm
              specs={specs}
              detectorSpecs={CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => ({
                ...spec,
                parameters: spec.parameters.map((parameter) => ({
                  ...parameter,
                })),
              }))}
              initial={initial}
              selectedAgentKey={selectedAgentKey}
            />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  )
}
