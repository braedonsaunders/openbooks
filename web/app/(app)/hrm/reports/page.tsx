import { ModuleView } from '../../../components/viewspec/module-view'
import { hrmReportsSpec, hrmReportsTitle, loadHrmReportsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await hrmReportsTitle() }
}

/**
 * The workforce reports launch pad — the Reports tab. The HRM workforce
 * report entities and the headcount statement preset as cards into the
 * report builder with the preset applied. Renders only when the hrm
 * feature gate is on and the actor holds both hrm.employment.read and
 * the reports grant the builder uses — the view 404s or access-denies
 * otherwise.
 */
export default async function HrmReportsPage() {
  const data = await loadHrmReportsPage()
  return <ModuleView spec={hrmReportsSpec(data)} data={data} searchParams={{}} trusted />
}
