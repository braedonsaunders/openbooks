import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadDataImport, dataImportSpec } from './view'

export default async function DataImportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadDataImport()
  return <ModuleView spec={dataImportSpec()} data={data} searchParams={sp} trusted />
}
