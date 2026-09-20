import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeBenefitsPage, meBenefitsSpec, meBenefitsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meBenefitsTitle() }
}

/**
 * Me benefits — current elections with stored payroll amounts, open
 * windows, dependents, and the elect/change dialogs. Renders only when
 * the hrm feature gate is on and the actor holds hrm.self.read — the
 * view 404s otherwise.
 */
export default async function MeBenefitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeBenefitsPage(sp)
  return <ModuleView spec={meBenefitsSpec(data)} data={data} searchParams={sp} trusted />
}
