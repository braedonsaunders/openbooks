import { getTranslations } from 'next-intl/server'
import { Card, CardContent, PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { AI_PROVIDER_SPECS } from '../../../../lib/assistant/client'
import { getOrgAiSettings } from '../../../../lib/assistant/ai-config'
import { AiSettingsForm, type ProviderSpecLite } from './AiSettingsForm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.ai')
  return { title: t('metaTitle') }
}

/**
 * Admin → AI settings, ported from beaconhs's admin/ai page. The provider,
 * model choices, and encrypted API key live in orgs.settings.ai — never in the
 * environment. The client form only ever sees non-secret fields (hasKey, not
 * the key itself).
 */
export default async function AiSettingsPage() {
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

  return (
    <PageContainer>
      <div className="max-w-2xl space-y-4">
        <PageHeader
          title={t('ai.title')}
          description={t('ai.description')}
          back={{ href: '/admin', label: t('hub.title') }}
        />
        <Card>
          <CardContent className="pt-6">
            <AiSettingsForm specs={specs} initial={initial} />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  )
}
