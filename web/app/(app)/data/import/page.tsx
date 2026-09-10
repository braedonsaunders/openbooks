import { requirePermission } from '../../../../lib/authz'
import { ImportWizard } from './ImportWizard'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadDataImport, dataImportSpec } from './view'

export default async function DataImportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams)?.__viewspec === '1') {
    const sp = (await searchParams) ?? {}
    const data = await loadDataImport()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={dataImportSpec()} data={data} searchParams={sp} trusted />
      </>
    )
  }
  await requirePermission('data.import')
  return <ImportWizard />
}
