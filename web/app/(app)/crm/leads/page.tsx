import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadLeads, leadsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Leads({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadLeads(sp)
  return <ModuleView spec={leadsSpec(data)} data={data} searchParams={sp} trusted />
}
