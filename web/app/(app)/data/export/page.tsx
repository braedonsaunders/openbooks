import { ModuleView } from '../../../../components/viewspec/module-view'
import { dataExportSpec, loadDataExport } from './view'

export default async function DataExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDataExport(sp)
  return <ModuleView spec={dataExportSpec(data)} data={data} searchParams={sp} trusted />
}
