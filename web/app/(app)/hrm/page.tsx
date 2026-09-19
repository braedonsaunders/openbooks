import { ModuleView } from '../../../components/viewspec/module-view'
import { hrmSpec, hrmTitle, loadHrmPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await hrmTitle() }
}

/**
 * Human resources module home — the workspace landing cockpit the nav
 * module opens. Headcount as-of today by employer subsidiary and department
 * (resolved through the canonical HRM read service, never a row count) is
 * the hero; the rail carries the live directory. Tabs are ROUTES (the /ap
 * idiom): the native employee list stays its own page and appears here as
 * a sibling tab when the viewer may open it. Renders only when the hrm
 * feature gate is on and the actor holds hrm.employment.read — the view
 * 404s otherwise.
 */
export default async function HrmHomePage() {
  const data = await loadHrmPage()
  return <ModuleView spec={hrmSpec(data)} data={data} searchParams={{}} trusted />
}
