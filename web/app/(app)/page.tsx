import { ModuleView } from '@/components/viewspec/module-view'
import { loadRootDashboard, rootDashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRootDashboard(sp)
  if (!data) return null
  return <ModuleView spec={rootDashboardSpec(data)} data={data} searchParams={sp} trusted />
}

