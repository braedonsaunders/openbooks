import { ModuleView } from '../../../../components/viewspec/module-view'
import { leaveQueueSpec, leaveQueueTitle, loadLeaveQueuePage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await leaveQueueTitle() }
}

/**
 * The org-wide leave queue — the Leave tab. Segments for pending approval,
 * upcoming, on leave today, and history, plus a calendar view by
 * department. Rows open the LeaveDrawer with balances in time and, where a
 * bank exists, in value — both labelled. Renders only when the hrm feature
 * gate is on and the actor holds hrm.leave.read — the view 404s otherwise.
 */
export default async function LeaveQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadLeaveQueuePage(sp)
  return <ModuleView spec={leaveQueueSpec(data, '/hrm/leave')} data={data} searchParams={sp} trusted />
}
