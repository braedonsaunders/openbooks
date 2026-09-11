import { ModuleView } from '../../../components/viewspec/module-view'
import { loadProjects, projectsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadProjects(sp)
  return <ModuleView spec={projectsSpec(data)} data={data} searchParams={sp} trusted />
}
