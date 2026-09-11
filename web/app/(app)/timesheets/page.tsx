import { ModuleView } from '../../../components/viewspec/module-view'
import { loadTimesheets, timesheetsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Timesheets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTimesheets(sp)
  return <ModuleView spec={timesheetsSpec(data)} data={data} searchParams={sp} trusted />
}
