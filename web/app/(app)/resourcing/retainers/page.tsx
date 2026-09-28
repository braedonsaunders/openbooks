import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRetainersPage, retainersSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function RetainersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRetainersPage(sp)
  return <ModuleView spec={retainersSpec(data)} data={data} searchParams={sp} trusted />
}
