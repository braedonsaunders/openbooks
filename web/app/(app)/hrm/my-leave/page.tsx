import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMyLeavePage, myLeaveSpec, myLeaveTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await myLeaveTitle() }
}

/**
 * My leave — the employee self-service inbox: own requests and balances
 * only. Renders only when the hrm feature gate is on and the actor holds
 * hrm.leave.request — the view 404s otherwise.
 */
export default async function MyLeavePage() {
  const data = await loadMyLeavePage()
  return <ModuleView spec={myLeaveSpec(data)} data={data} searchParams={{}} trusted />
}
