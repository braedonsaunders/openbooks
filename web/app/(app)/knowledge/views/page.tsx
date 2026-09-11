import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadViewsPage, viewsSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function ViewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadViewsPage(sp)
  return <ModuleView spec={viewsSpec(data)} data={data} searchParams={sp} trusted />
}
