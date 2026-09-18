import { ModuleView } from '../../../components/viewspec/module-view'
import { loadQuery, querySpec } from './view'

export default async function QueryConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadQuery()
  return <ModuleView spec={querySpec()} data={data} searchParams={sp} trusted />
}
