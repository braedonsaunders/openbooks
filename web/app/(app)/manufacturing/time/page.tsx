import { ModuleView } from '@/components/viewspec/module-view'
import { loadTimesheets, timesheetsSpec } from '../../timesheets/view'
export const dynamic = 'force-dynamic'
export default async function ProductionTime({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const sp=await searchParams
  const data=await loadTimesheets(sp,'production')
  return <ModuleView spec={timesheetsSpec(data)} data={data} searchParams={sp} trusted />
}
