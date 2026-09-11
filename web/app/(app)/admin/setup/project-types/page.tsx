import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadProjectTypes, projectTypesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ProjectTypesSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadProjectTypes()
  return <ModuleView spec={projectTypesSpec(data)} data={data} searchParams={sp} trusted />
}
