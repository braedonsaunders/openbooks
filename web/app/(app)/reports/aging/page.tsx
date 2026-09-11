import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAging, agingSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function Aging({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAging(sp)
  return <ModuleView spec={agingSpec(data)} data={data} searchParams={sp} trusted />
}
