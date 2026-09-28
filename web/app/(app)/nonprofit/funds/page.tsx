import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadFunds, fundsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Funds({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFunds(sp)
  return <ModuleView spec={fundsSpec(data)} data={data} searchParams={sp} trusted />
}
