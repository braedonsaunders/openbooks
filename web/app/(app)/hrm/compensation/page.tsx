import { ModuleView } from '../../../../components/viewspec/module-view'
import { compensationSpec, compensationTitle, loadCompensationPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await compensationTitle() }
}

/**
 * The Compensation tab — job architecture, bands, merit cycles,
 * headcount plans, and the equity surface. Renders only when the
 * hrmCompensation feature gate is on and the actor holds
 * hrm.compensation.read — the loader 404s otherwise.
 */
export default async function CompensationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCompensationPage(sp)
  return <ModuleView spec={compensationSpec(data)} data={data} searchParams={sp} trusted />
}
