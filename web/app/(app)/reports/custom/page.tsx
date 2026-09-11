import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomReports, customReportsSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function CustomReports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomReports(sp)
  return <ModuleView spec={customReportsSpec(data)} data={data} searchParams={sp} trusted />
}
