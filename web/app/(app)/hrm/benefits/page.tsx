import { ModuleView } from '../../../../components/viewspec/module-view'
import { benefitsSpec, benefitsTitle, loadBenefitsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await benefitsTitle() }
}

/**
 * The Benefits tab. Windows segmented by status plus an enrolments segment
 * across windows; the window drawer carries progress and its enrolments;
 * pending rows carry the approve island. Renders only when the hrm feature
 * gate is on and the actor holds hrm.benefits.read — the view 404s
 * otherwise.
 */
export default async function BenefitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBenefitsPage(sp)
  return <ModuleView spec={benefitsSpec(data, '/hrm/benefits')} data={data} searchParams={sp} trusted />
}
