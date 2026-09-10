import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadApiSchema } from '../../../lib/api/schema-registry'
import { ApiConsole } from './ApiConsole'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadApiDocs, apiDocsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('apiDocs')
  return { title: t('metaTitle') }
}

export default async function ApiDocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadApiDocs(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={apiDocsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('api.keys.manage')
  await requireFeatureEnabled(authz.user.orgId, 'apiAccess')
  const schema = await loadApiSchema(authz.user.orgId)

  // The console owns the full-height workbench (record-type rail + reference +
  // interactive runner). The schema is plain data — safe to hand to the client.
  return <ApiConsole schema={schema} />
}
