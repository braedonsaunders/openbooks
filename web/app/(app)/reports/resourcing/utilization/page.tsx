import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadUtilizationReport, utilizationReportSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function UtilizationReport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadUtilizationReport(sp)
  return <ModuleView spec={utilizationReportSpec(data)} data={data} searchParams={sp} trusted />
}
