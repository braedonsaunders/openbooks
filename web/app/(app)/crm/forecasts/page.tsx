import { ModuleView } from '../../../../components/viewspec/module-view'
import { forecastsSpec, loadForecasts } from './view'

export const dynamic = 'force-dynamic'



export default async function Forecasts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadForecasts(sp)
  return <ModuleView spec={forecastsSpec(data)} data={data} searchParams={sp} trusted />
}



