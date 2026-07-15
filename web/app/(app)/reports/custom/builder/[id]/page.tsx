import { notFound } from 'next/navigation'
import { requirePermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
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
  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()

  return (
    <ReportBuilder
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
