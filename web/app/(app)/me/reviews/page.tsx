import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeReviewsPage, meReviewsSpec, meReviewsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meReviewsTitle() }
}

/**
 * Me reviews — owed self-assessments, shared manager reviews with the
 * acknowledge action, and own goals with progress. Renders only when the
 * hrm feature gate is on and the actor holds hrm.self.read — the view
 * 404s otherwise.
 */
export default async function MeReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeReviewsPage(sp)
  return <ModuleView spec={meReviewsSpec(data)} data={data} searchParams={sp} trusted />
}
