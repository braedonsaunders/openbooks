import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadDataImport, dataImportSpec } from './view'

export default async function DataImportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadDataImport()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={dataImportSpec()} data={data} searchParams={sp} trusted />
    </>
  )
}
