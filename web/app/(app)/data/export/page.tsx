import { ModuleView } from '../../../../components/viewspec/module-view'
import { dataExportSpec, loadDataExport } from './view'

export default async function DataExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDataExport(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={dataExportSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
