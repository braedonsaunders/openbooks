import { ModuleView } from '../../../components/viewspec/module-view'
import { loadReportsHub, reportsHubSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Reports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadReportsHub()
  return <ModuleView spec={reportsHubSpec(data)} data={data} searchParams={sp} trusted />
}
