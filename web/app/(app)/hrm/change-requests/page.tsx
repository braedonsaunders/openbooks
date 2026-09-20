import { ModuleView } from '../../../components/viewspec/module-view'
import { changeRequestQueueSpec, changeRequestQueueTitle, loadChangeRequestQueuePage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await changeRequestQueueTitle() }
}

/**
 * The org-wide employment change-request queue — the Change requests tab.
 * Status segments with counts, employee, kind, effective date, requester
 * and submitted-at per row, opening the existing ChangeRequestDrawer with
 * ChangeRequestActions on every row. Renders only when the hrm feature
 * gate is on and the actor holds hrm.employment.read — the view 404s
 * otherwise.
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
