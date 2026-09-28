import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadCapacityDemandReport, capacityDemandReportSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function CapacityDemandReport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadCapacityDemandReport(sp)
  return <ModuleView spec={capacityDemandReportSpec(data)} data={data} searchParams={sp} trusted />
}
