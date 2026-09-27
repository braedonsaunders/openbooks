import { ModuleView } from '../../../../../components/viewspec/module-view'
import { hiringPipelinesSpec, loadHiringPipelines } from './view'

export const dynamic = 'force-dynamic'

export default async function HiringPipelinesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadHiringPipelines()
  return <ModuleView spec={hiringPipelinesSpec(data)} data={data} searchParams={sp} trusted />
}
