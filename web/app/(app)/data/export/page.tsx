import { requirePermission } from '../../../../lib/authz'
import { PageContainer } from '../../../../components/page-layout'
import { ExportClient } from './ExportClient'

export default async function DataExportPage() {
  await requirePermission('data.export')
  return (
    <PageContainer>
      <ExportClient />
    </PageContainer>
  )
}
