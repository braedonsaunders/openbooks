import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminAi, adminAiSpec } from './view'

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
  const sp = await searchParams
  const data = await loadAdminAi(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={adminAiSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
