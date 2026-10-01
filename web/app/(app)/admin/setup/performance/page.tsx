import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPerformanceSetup, performanceSetupSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PerformanceSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadPerformanceSetup()
  return <ModuleView spec={performanceSetupSpec(data)} data={data} searchParams={sp} trusted />
}
