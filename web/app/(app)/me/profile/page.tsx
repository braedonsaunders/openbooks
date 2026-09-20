import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeProfilePage, meProfileSpec, meProfileTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meProfileTitle() }
}

/**
 * Me profile — the person's party fields with a URL-drawer edit form that
 * files the profile_change request. Renders only when the hrm feature gate
 * is on and the actor holds hrm.self.read — the view 404s otherwise.
 */
export default async function MeProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeProfilePage(sp)
  return <ModuleView spec={meProfileSpec(data)} data={data} searchParams={sp} trusted />
}
