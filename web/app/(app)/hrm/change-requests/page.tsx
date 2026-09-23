import { ModuleView } from '../../../../components/viewspec/module-view'
import { changeRequestQueueSpec, changeRequestQueueTitle, loadChangeRequestQueuePage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await changeRequestQueueTitle() }
}

/**
 * The org-wide employment change-request queue — the Change requests tab.
 * Status segments with counts, employee, kind, effective date, requester
 * and submitted-at per row; every row's open link navigates to the
 * shareable ?request=<id> URL, which renders the request-detail drawer
 * (subject, proposed change, reason, history, and decision context, with
 * the existing ChangeRequestActions lifecycle island inside). The propose
 * dialog files new drafts through the existing ChangeRequestDrawer.
 * Renders only when the hrm feature gate is on and the actor holds
 * hrm.employment.read — the view 404s otherwise.
 */
export default async function ChangeRequestQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadChangeRequestQueuePage(sp)
  return <ModuleView spec={changeRequestQueueSpec(data)} data={data} searchParams={sp} trusted />
}
