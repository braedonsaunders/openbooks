import { ModuleView } from '../../../../../components/viewspec/module-view'
import { equitySpec, equityTitle, loadEquityPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await equityTitle() }
}

/**
 * Pay equity — the latest frozen gap snapshot with per-category gaps
 * and joint-assessment flags. Renders only when hrmPayTransparency is
 * on and the actor holds hrm.compensation.read.
 */
export default async function EquityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadEquityPage(sp)
  return <ModuleView spec={equitySpec(data)} data={data} searchParams={sp} trusted />
}
