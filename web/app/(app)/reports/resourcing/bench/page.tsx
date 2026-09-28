import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadBenchReport, benchReportSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function BenchReport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadBenchReport(sp)
  return <ModuleView spec={benchReportSpec(data)} data={data} searchParams={sp} trusted />
}
