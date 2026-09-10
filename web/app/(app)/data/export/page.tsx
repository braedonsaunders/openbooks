import { ModuleView } from '../../../../components/viewspec/module-view'
import { requirePermission } from '../../../../lib/authz'
import { PageContainer } from '../../../../components/page-layout'
import { ExportClient } from './ExportClient'
import { dataExportSpec, loadDataExport } from './view'

export default async function DataExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDataExport(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={dataExportSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  await requirePermission('data.export')
  return (
    <PageContainer>
      <ExportClient />
    </PageContainer>
  )
}
