import { notFound, redirect } from 'next/navigation'
import { requirePermission } from '../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { isUuid } from '../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { orgBranding } from '../../../../../../lib/report-pdf'
import { statementPageHref } from '../../../../../../lib/report-run'
import { hiddenReportEntityKeys } from '../../../../../../lib/report-authz'
import { ReportBuilder } from './ReportBuilder'

export const dynamic = 'force-dynamic'

export default async function ReportBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const authz = await requirePermission('reports.create')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const [definition, branding, inventoryEnabled] = await Promise.all([
    loadReportDefinition(authz.user.orgId, id),
    orgBranding(),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
  ])
  if (!definition) notFound()
  // Standard statement reports keep their rich drill-through pages — the entity
  // query-builder edits `query` definitions only.
  if (definition.report_type === 'statement') redirect(statementPageHref(definition.statement))
  if (!definition.query) notFound()

  return (
    <ReportBuilder
      hiddenEntityKeys={await hiddenReportEntityKeys(authz)}
      inventoryEnabled={inventoryEnabled}
      company={branding.orgName}
      definition={{
        id: definition.id,
        kind: definition.kind,
        name: definition.name,
        description: definition.description,
        query: definition.query,
        layout: definition.layout,
      }}
    />
  )
}
