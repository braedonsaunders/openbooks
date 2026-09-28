import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadGrants, grantsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Grants({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadGrants(sp)
  return <ModuleView spec={grantsSpec(data)} data={data} searchParams={sp} trusted />
}
