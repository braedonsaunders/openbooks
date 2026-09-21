import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadOrgChartPage, orgChartSpec, orgChartTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await orgChartTitle() }
}

/**
 * Org chart tab: the as-of tree with vacancies plus the directory.
 * Renders when hrm and hrmOrgChart are on and the actor holds
 * hrm.employment.read OR hrm.self.read — the loader 404s otherwise.
 */
export default async function OrgChartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadOrgChartPage(sp)
  return <ModuleView spec={orgChartSpec(data)} data={data} searchParams={sp} trusted />
}
