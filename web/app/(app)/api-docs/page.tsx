import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadApiSchema } from '../../../lib/api/schema-registry'
import { ApiConsole } from './ApiConsole'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('apiDocs')
  return { title: t('metaTitle') }
}

export default async function ApiDocsPage() {
  const authz = await requirePermission('api.keys.manage')
  await requireFeatureEnabled(authz.user.orgId, 'apiAccess')
  const schema = await loadApiSchema(authz.user.orgId)

  // The console owns the full-height workbench (record-type rail + reference +
  // interactive runner). The schema is plain data — safe to hand to the client.
  return <ApiConsole schema={schema} />
}
