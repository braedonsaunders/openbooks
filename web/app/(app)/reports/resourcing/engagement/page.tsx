import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadEngagementReport, engagementReportSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function EngagementReport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadEngagementReport(sp)
  return <ModuleView spec={engagementReportSpec(data)} data={data} searchParams={sp} trusted />
}
