import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRecruitingPage, recruitingSpec, recruitingTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await recruitingTitle() }
}

/**
 * Recruiting tab: requisitions with the funnel, candidates, interviews and
 * offers behind drawers. Status segments filter server-side; every drawer
 * opens through the URL, so the selection is shareable and closes by
 * navigation. Renders only when the hrm feature gate is on and the actor
 * holds hrm.recruiting.read — the loader 404s otherwise.
 */
export default async function RecruitingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRecruitingPage(sp)
  return <ModuleView spec={recruitingSpec(data)} data={data} searchParams={sp} trusted />
}
