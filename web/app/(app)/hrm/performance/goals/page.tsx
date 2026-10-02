import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadGoalsWorkspace, goalsWorkspaceSpec } from './view'
export const dynamic = 'force-dynamic'
export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams,
    data = await loadGoalsWorkspace(sp)
  return (
    <ModuleView
      spec={goalsWorkspaceSpec(data)}
      data={data}
      searchParams={sp}
      trusted
    />
  )
}
