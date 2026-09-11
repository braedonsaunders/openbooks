import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadProspects, prospectsSpec } from './view'
export const dynamic = 'force-dynamic'
export default async function Prospects({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadProspects(sp)
  return <ModuleView spec={prospectsSpec(data)} data={data} searchParams={sp} trusted />
}
