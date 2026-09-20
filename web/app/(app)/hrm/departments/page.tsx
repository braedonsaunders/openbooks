import { ModuleView } from '../../../components/viewspec/module-view'
import { hrmDepartmentsSpec, hrmDepartmentsTitle, loadHrmDepartmentsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await hrmDepartmentsTitle() }
}

/**
 * The department headcount board — the Departments tab. Headcount as of
 * today per department from getHeadcountAsOf with the employer subsidiary
 * breakdown and an explicit Unassigned row, read-only, with the link to
 * where departments are managed in Setup. Renders only when the hrm
 * feature gate is on and the actor holds hrm.employment.read — the view
 * 404s otherwise.
 */
export default async function HrmDepartmentsPage() {
  const data = await loadHrmDepartmentsPage()
  return <ModuleView spec={hrmDepartmentsSpec(data)} data={data} searchParams={{}} trusted />
}
